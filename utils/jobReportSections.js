// ── Job report section payload: validate, clamp, re-snapshot ─────────────────
// Everything a job report form submits passes through here before it is
// stored. The walk is driven by the TEMPLATE (utils/jobReportTemplates.js),
// never by the client's payload, so a key the template does not declare simply
// does not survive — the same shape discipline that keeps an MIS line item
// honest.
//
// The three reference field types (customer / variety / dmContent) are
// re-fetched and re-snapshotted server-side from their id alone. A browser
// that posts {customerId, name: 'someone else'} gets the real customer's name
// stored, and a browser that posts an id it has no business seeing gets null
// — resolution is scoped exactly like the pickers are (CRM dataScope for
// customers, branch access for Inventory varieties), so this route cannot be
// used to read a record the caller could not already open.

'use strict';

const mongoose = require('mongoose');
const dbConnection = require('../connections/xmsPr');
const customerSchema       = require('../models/customerModel');
const inventoryProductSchema = require('../models/inventoryProductModel');
const inventoryVariantSchema = require('../models/inventoryVariantModel');
const rawContentSchema     = require('../models/rawContentModel');
const readyToUploadSchema  = require('../models/readyToUploadModel');
const whatsappShareSchema  = require('../models/whatsappShareModel');
const externalLinkPageSchema = require('../models/externalLinkPageModel');
const { isSuperAdmin, getUserBranches, getEffectiveScopes, getEffectivePermissions, Group } = require('./rbac');
const { resolveJobReportTemplate, CHANNEL_VALUES } = require('./jobReportTemplates');

const Customer   = dbConnection.models.customer         || dbConnection.model('customer', customerSchema);
const InvProduct = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const RawContent    = dbConnection.models.rawContent       || dbConnection.model('rawContent', rawContentSchema);
const ReadyToUpload = dbConnection.models.readyToUpload    || dbConnection.model('readyToUpload', readyToUploadSchema);
const WhatsappShare = dbConnection.models.whatsappShare    || dbConnection.model('whatsappShare', whatsappShareSchema);
const ExternalLinkPage = dbConnection.models.externalLinkPage || dbConnection.model('externalLinkPage', externalLinkPageSchema);

// A report is a day's work, not a data dump. The caps are generous enough that
// nobody meets them in practice and low enough that a runaway client cannot
// push an unbounded document into Mongo.
const MAX_ROWS_PER_TABLE = 100;
const MAX_TEXT = 500;
const MAX_TEXTAREA = 8000;

const isId = (v) => typeof v === 'string' ? /^[0-9a-fA-F]{24}$/.test(v) : !!(v && v._bsontype === 'ObjectID');

const clampText = (v, max) => {
  if (v == null) return '';
  return String(v).slice(0, max);
};

const toNumber = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 'HH:MM', 24h. Anything else is dropped rather than half-stored — a time
// field that says "25:99" on a printed sheet is worse than a blank one.
const toTime = (v) => {
  const s = String(v == null ? '' : v).trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
};

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const customerLabel = (c) => {
  const p = (c && c.personalInformation) || {};
  const name = p.companyName || [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return name || c.phoneNumber || '';
};

// ── Row-level scope, one definition per module ──────────────────────────────
// Each of these mirrors the filter its own section already applies to its own
// list, and BOTH the picker route and the save path use it — a security filter
// that exists twice is a security filter that drifts.

// Mirrors routes/crm/customer.js's own buildScopeFilter — a report may only
// reference a customer its author could see in the CRM list.
async function crmScopeFilter(userId) {
  const scopes = await getEffectiveScopes(userId);
  const scope = scopes.crm;
  if (!scope || scope === 'all') return null;
  if (scope === 'mine') return { $or: [{ owner: userId }, { assignedTo: userId }] };
  const groups = await Group.find({ members: userId, deleteDate: null }).lean();
  const memberIds = [...new Set(groups.flatMap((g) => (g.members || []).map((m) => String(m))))];
  if (!memberIds.length) return { $or: [{ owner: userId }, { assignedTo: userId }] };
  return { $or: [{ owner: { $in: memberIds } }, { assignedTo: { $in: memberIds } }] };
}

// Mirrors routes/digitalMarketing/main.js's buildScopeFilter: on a 'mine'
// scope a creator only sees their own content, so they can only point a report
// at their own content either.
async function dmScopeFilter(userId) {
  const scopes = await getEffectiveScopes(userId);
  const scope = scopes.digitalMarketing;
  if (!scope || scope === 'all') return null;
  const mine = new mongoose.Types.ObjectId(String(userId));
  if (scope === 'mine') return { owner: mine };
  const groups = await Group.find({ members: userId, deleteDate: null }).select('members').lean();
  const memberIds = [...new Set(groups.flatMap((g) => (g.members || []).map(String)))];
  if (!memberIds.length) return { owner: mine };
  return { owner: { $in: memberIds.map((id) => new mongoose.Types.ObjectId(id)) } };
}

// Mirrors routes/inventory/main.js: the Inventory scope is judged on the
// PRODUCT's createdBy, not the variant's, which is why this returns a filter
// for the product query rather than the variant one.
async function inventoryProductScopeFilter(userId) {
  const scopes = await getEffectiveScopes(userId);
  const scope = scopes.inventory;
  if (!scope || scope === 'all') return null;
  const mine = new mongoose.Types.ObjectId(String(userId));
  if (scope === 'mine') return { createdBy: mine };
  const groups = await Group.find({ members: userId, deleteDate: null }).select('members').lean();
  const memberIds = [...new Set(groups.flatMap((g) => (g.members || []).map(String)))];
  if (!memberIds.length) return { createdBy: mine };
  return { createdBy: { $in: memberIds.map((id) => new mongoose.Types.ObjectId(id)) } };
}

// Every reference in the whole payload is collected first and resolved in one
// batch per type — a 100-row table of customers is two queries, not a hundred.
function collectRefs(tpl, raw) {
  const refs = { customer: new Set(), variety: new Set(), dmContent: new Map() };

  const takeRef = (type, value) => {
    if (!value) return;
    if (type === 'dmContent') {
      const kind = String(value.kind || '');
      const id = String(value.id || value.recordId || '');
      if (!kind || !isId(id)) return;
      if (!refs.dmContent.has(kind)) refs.dmContent.set(kind, new Set());
      refs.dmContent.get(kind).add(id);
      return;
    }
    const id = String(type === 'variety'
      ? (value.variantId || value.id || '')
      : (value.customerId || value.id || ''));
    if (isId(id)) refs[type].add(id);
  };

  (tpl.sections || []).forEach((section) => {
    const given = raw && raw[section.key];
    if (section.kind === 'table') {
      if (!Array.isArray(given)) return;
      given.slice(0, MAX_ROWS_PER_TABLE).forEach((row) => {
        (section.columns || []).forEach((col) => {
          // A recipient only has something to resolve in its customer mode.
          if (col.type === 'recipient') {
            const v = row && row[col.key];
            if (v && v.mode === 'customer') takeRef('customer', v);
            return;
          }
          if (refs[col.type] || col.type === 'dmContent') takeRef(col.type, row && row[col.key]);
        });
      });
    } else {
      if (!given || typeof given !== 'object') return;
      (section.fields || []).forEach((field) => {
        if (field.type === 'recipient') {
          const v = given[field.key];
          if (v && v.mode === 'customer') takeRef('customer', v);
          return;
        }
        if (refs[field.type] || field.type === 'dmContent') takeRef(field.type, given[field.key]);
      });
    }
  });

  return refs;
}

async function loadCustomers(ids, userId, perms) {
  // A dataScope answers "which of the records I may see", NOT "may I see any".
  // Without crm:view there is nothing to scope, and a report must not become a
  // way to read a name out of the CRM. Default-deny, as everywhere else.
  if (!ids.size || !perms.has('crm:view')) return new Map();
  const query = { _id: { $in: Array.from(ids) }, deleteDate: null };
  const scope = await crmScopeFilter(userId);
  if (scope) Object.assign(query, scope);
  const rows = await Customer.find(query).select('_id personalInformation phoneNumber').lean();
  return new Map(rows.map((c) => [String(c._id), {
    customerId: c._id, name: customerLabel(c), phone: c.phoneNumber || '',
  }]));
}

async function loadVarieties(ids, userId, perms) {
  if (!ids.size || !perms.has('inventory:view')) return new Map();
  const superAdmin = await isSuperAdmin(userId);
  const branchIds = superAdmin ? null : await getUserBranches(userId);
  const query = { _id: { $in: Array.from(ids) }, deleteDate: null };
  if (branchIds) query.branchId = { $in: branchIds };
  const variants = await InvVariant.find(query).select('_id productId branchId code unit quantity').lean();

  // Two gates, both of them the Inventory section's own: the caller must hold
  // the branch, and must pass Inventory's row-level scope on the product. A
  // variant whose product does not come back is simply not resolved, so the
  // cell saves as empty rather than quietly carrying a record the author
  // cannot open.
  const productQuery = { _id: { $in: variants.map((v) => v.productId) } };
  const scope = superAdmin ? null : await inventoryProductScopeFilter(userId);
  if (scope) Object.assign(productQuery, scope);
  const products = await InvProduct.find(productQuery).select('_id name nameAr').lean();

  const productById = new Map(products.map((p) => [String(p._id), p]));
  return new Map(variants
    .filter((v) => productById.has(String(v.productId)))
    .map((v) => {
      const p = productById.get(String(v.productId)) || {};
      return [String(v._id), {
        variantId: v._id, productId: v.productId, branchId: v.branchId,
        code: v.code || '', productName: p.name || '', productNameAr: p.nameAr || '',
        unit: v.unit || '',
      }];
    }));
}

// Digital Marketing is NOT branch-scoped (confirmed decision, see CLAUDE.md),
// so a DM record resolves on existence alone — the same bar as opening it in
// the DM section with digitalMarketing:view.
const DM_KINDS = {
  rawContent:    { model: () => RawContent,    scoped: true,  title: (d) => d.title || '' },
  readyToUpload: { model: () => ReadyToUpload, scoped: true,  title: (d) => d.title || d.caption || '' },
  whatsappShare: { model: () => WhatsappShare, scoped: false, title: (d) => [d.productName, d.variantCode].filter(Boolean).join(' · ') },
  linkPage:      { model: () => ExternalLinkPage, scoped: false, title: (d) => d.title || d.companyName || d.code || '' },
};

async function loadDmContents(byKind, userId, perms) {
  const out = new Map();
  if (!perms.has('digitalMarketing:view')) return out;
  // Digital Marketing is not branch-scoped, but it IS row-level scoped: on a
  // 'mine' scope a creator may only reference their own content.
  const scope = (await isSuperAdmin(userId)) ? null : await dmScopeFilter(userId);
  await Promise.all(Array.from(byKind.entries()).map(async ([kind, ids]) => {
    const spec = DM_KINDS[kind];
    if (!spec || !ids.size) return;
    const query = { _id: { $in: Array.from(ids) }, deleteDate: null };
    // whatsappShare and linkPage carry no `owner`, so the scope cannot be
    // applied to them — they are deliberately shared records (a share history
    // and a public page), and scoping them would hide the team's own work.
    if (scope && spec.scoped) Object.assign(query, scope);
    const rows = await spec.model().find(query).lean();
    rows.forEach((d) => out.set(`${kind}:${String(d._id)}`, {
      kind, recordId: d._id, title: spec.title(d) || '',
    }));
  }));
  return out;
}

function resolveValue(field, value, resolved) {
  switch (field.type) {
    case 'customer': {
      const id = value && String(value.customerId || value.id || '');
      return (id && resolved.customers.get(id)) || null;
    }
    case 'variety': {
      if (!value) return null;
      // A field with allowText also takes a stone the catalogue does not carry
      // — stored as {text} so it can never be mistaken for a real variety.
      if (value.text != null && !value.variantId && !value.id) {
        const text = clampText(value.text, MAX_TEXT).trim();
        return text ? { text } : null;
      }
      const id = String(value.variantId || value.id || '');
      return (id && resolved.varieties.get(id)) || null;
    }
    case 'recipient': {
      if (!value) return null;
      const mode = String(value.mode || '');
      if (mode === 'channel') {
        const channel = String(value.channel || '');
        return CHANNEL_VALUES.includes(channel) ? { mode: 'channel', channel } : null;
      }
      if (mode === 'customer') {
        const id = String(value.customerId || value.id || '');
        const found = id && resolved.customers.get(id);
        return found ? { mode: 'customer', ...found } : null;
      }
      const text = clampText(value.text, MAX_TEXT).trim();
      return text ? { mode: 'text', text } : null;
    }
    case 'dmContent': {
      if (!value) return null;
      const key = `${String(value.kind || '')}:${String(value.id || value.recordId || '')}`;
      return resolved.dmContents.get(key) || null;
    }
    case 'date':     return toDate(value);
    case 'time':     return toTime(value);
    case 'number':
    case 'money':    return toNumber(value);
    case 'textarea': return clampText(value, MAX_TEXTAREA);
    case 'select': {
      const allowed = (field.options || []).map((o) => o.value);
      const v = String(value == null ? '' : value);
      return allowed.includes(v) ? v : '';
    }
    default:         return clampText(value, MAX_TEXT);
  }
}

// A computed column is ALWAYS recalculated here — the browser shows a live
// total for the person typing, but what gets stored and printed is the
// server's own arithmetic.
function applyComputed(section, row) {
  (section.columns || []).forEach((col) => {
    if (!col.computed) return;
    const [a, b] = String(col.computed).split('*');
    const x = toNumber(row[a]);
    const y = toNumber(row[b]);
    row[col.key] = (x == null || y == null) ? null : Math.round(x * y * 100) / 100;
  });
}

// A row the user started and abandoned is noise on a printed sheet — dropped
// rather than stored as a blank line. A reference cell is an OBJECT, so a
// shallow truthiness test would call {text:''} filled; this looks inside.
const cellIsEmpty = (v) => {
  if (v == null || v === '') return true;
  if (typeof v !== 'object') return false;
  return Object.values(v).every((inner) => inner == null || inner === '');
};
const rowIsEmpty = (row) => Object.values(row).every(cellIsEmpty);

/**
 * @returns {{ sections: Object, links: Object, bound: Object }}
 *   sections — the cleaned payload to store
 *   links    — flat de-duplicated references, for reverse lookups and search
 *   bound    — values a field declared `bind` for (reportDate / title / body),
 *              which stay real top-level model columns so the admin list,
 *              notifications and every pre-template report keep working
 */
async function resolveJobReportSections(userId, templateKey, rawSections) {
  const tpl = resolveJobReportTemplate(templateKey);
  const raw = (rawSections && typeof rawSections === 'object') ? rawSections : {};

  const refs = collectRefs(tpl, raw);
  // Resolved once for the whole payload: the keys decide WHETHER a reference
  // type resolves at all, the scopes decide WHICH records within it.
  const perms = await getEffectivePermissions(userId);
  const [customers, varieties, dmContents] = await Promise.all([
    loadCustomers(refs.customer, userId, perms),
    loadVarieties(refs.variety, userId, perms),
    loadDmContents(refs.dmContent, userId, perms),
  ]);
  const resolved = { customers, varieties, dmContents };

  const sections = {};
  const bound = {};
  const links = { customers: [], varieties: [], dmContents: [] };
  const seen = { customers: new Set(), varieties: new Set(), dmContents: new Set() };

  const noteLinks = (value) => {
    if (!value) return;
    if (value.customerId && !seen.customers.has(String(value.customerId))) {
      seen.customers.add(String(value.customerId)); links.customers.push(value);
    } else if (value.variantId && !seen.varieties.has(String(value.variantId))) {
      seen.varieties.add(String(value.variantId)); links.varieties.push(value);
    } else if (value.recordId && !seen.dmContents.has(`${value.kind}:${value.recordId}`)) {
      seen.dmContents.add(`${value.kind}:${value.recordId}`); links.dmContents.push(value);
    }
  };

  (tpl.sections || []).forEach((section) => {
    const given = raw[section.key];

    if (section.kind === 'table') {
      const rows = Array.isArray(given) ? given.slice(0, MAX_ROWS_PER_TABLE) : [];
      const clean = [];
      rows.forEach((rawRow) => {
        if (!rawRow || typeof rawRow !== 'object') return;
        const row = {};
        (section.columns || []).forEach((col) => {
          row[col.key] = resolveValue(col, rawRow[col.key], resolved);
          noteLinks(row[col.key]);
        });
        applyComputed(section, row);
        if (!rowIsEmpty(row)) clean.push(row);
      });
      sections[section.key] = clean;
      return;
    }

    const obj = (given && typeof given === 'object') ? given : {};
    const out = {};
    (section.fields || []).forEach((field) => {
      const value = resolveValue(field, obj[field.key], resolved);
      out[field.key] = value;
      noteLinks(value);
      if (field.bind) bound[field.bind] = value;
    });
    sections[section.key] = out;
  });

  return { sections, links, bound };
}

module.exports = {
  resolveJobReportSections, DM_KINDS,
  MAX_ROWS_PER_TABLE, customerLabel,
  crmScopeFilter, dmScopeFilter, inventoryProductScopeFilter,
};
