/**
 * Imports WooCommerce product-page content into XMS Digital Marketing product content.
 *
 * Dry run:
 *   node scripts/importWordPressProductContent.js --sql "C:\Users\S76\Local Sites\lmc-local\app\sql\local.sql"
 *
 * Write:
 *   node scripts/importWordPressProductContent.js --sql "C:\Users\S76\Local Sites\lmc-local\app\sql\local.sql" --yes
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');

const productContentSchema = require('../models/websiteProductContentModel');
const productTaxonomySchema = require('../models/websiteProductTaxonomyModel');
const { sanitizeHtml } = require('../utils/sanitizeHtml');

const DEFAULT_SQL = 'C:\\Users\\S76\\Local Sites\\lmc-local\\app\\sql\\local.sql';
const DEFAULT_MEDIA_ROOT = 'C:\\Users\\S76\\Local Sites\\lmc-local\\app\\public';
const VALID_LANGS = new Set(['en', 'ar', 'fa']);

const POST_COLUMNS = [
  'ID', 'post_author', 'post_date', 'post_date_gmt', 'post_content', 'post_title', 'post_excerpt',
  'post_status', 'comment_status', 'ping_status', 'post_password', 'post_name', 'to_ping', 'pinged',
  'post_modified', 'post_modified_gmt', 'post_content_filtered', 'post_parent', 'guid', 'menu_order',
  'post_type', 'post_mime_type', 'comment_count',
];
const POSTMETA_COLUMNS = ['meta_id', 'post_id', 'meta_key', 'meta_value'];
const TERM_COLUMNS = ['term_id', 'name', 'slug', 'term_group'];
const TERM_TAXONOMY_COLUMNS = ['term_taxonomy_id', 'term_id', 'taxonomy', 'description', 'parent', 'count'];
const TERM_REL_COLUMNS = ['object_id', 'term_taxonomy_id', 'term_order'];
const TERM_META_COLUMNS = ['meta_id', 'term_id', 'meta_key', 'meta_value'];

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeProductCode(input) {
  const raw = String(input || '').trim().toUpperCase();
  const match = raw.match(/[A-Z]{2}\d{2}/);
  return match ? match[0] : raw;
}

function isUsableSku(value) {
  const sku = String(value || '').trim();
  return Boolean(sku) && !/^(?:N\/?A|NONE|NULL|-)$/i.test(sku);
}

function decodeSqlString(value) {
  return String(value || '').replace(/\\([0bnrtZ'"\\])/g, (_m, ch) => {
    if (ch === '0') return '\0';
    if (ch === 'b') return '\b';
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    if (ch === 'Z') return '\x1a';
    return ch;
  });
}

function parseValue(raw) {
  const v = raw.trim();
  if (/^NULL$/i.test(v)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseSqlRow(row) {
  const values = [];
  let cur = '';
  let inString = false;

  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (inString) {
      if (ch === '\\') {
        cur += ch;
        if (i + 1 < row.length) cur += row[++i];
      } else if (ch === "'") {
        if (row[i + 1] === "'") {
          cur += "'";
          i += 1;
        } else {
          inString = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === "'") {
      inString = true;
    } else if (ch === ',') {
      values.push(parseValue(decodeSqlString(cur)));
      cur = '';
    } else {
      cur += ch;
    }
  }
  values.push(parseValue(decodeSqlString(cur)));
  return values;
}

function rowsFromInsert(sql) {
  const valuesAt = sql.indexOf('VALUES');
  if (valuesAt < 0) return [];
  const body = sql.slice(valuesAt + 6).replace(/;\s*$/, '');
  const rows = [];
  let depth = 0;
  let start = -1;
  let inString = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === "'" && body[i + 1] === "'") i += 1;
      else if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) rows.push(body.slice(start, i));
    }
  }
  return rows;
}

function objectFromRow(values, columns) {
  return columns.reduce((obj, col, idx) => {
    obj[col] = values[idx];
    return obj;
  }, {});
}

function parseTranslationMap(raw) {
  const out = {};
  const re = /s:\d+:"([^"]+)";i:(\d+)/g;
  let match;
  while ((match = re.exec(String(raw || '')))) {
    if (VALID_LANGS.has(match[1])) out[match[1]] = Number(match[2]);
  }
  return out;
}

function setLangField(target, base, lang, value) {
  if (value == null) return;
  const clean = String(value || '').trim();
  if (lang === 'ar') target[`${base}Ar`] = clean;
  else if (lang === 'fa') target[`${base}Fa`] = clean;
  else target[base] = clean;
}

async function parseDump(sqlPath) {
  const posts = new Map();
  const attachments = new Map();
  const variationsByParent = new Map();
  const meta = new Map();
  const terms = new Map();
  const termTaxonomies = new Map();
  const relsByObject = new Map();
  const termMeta = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(sqlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.startsWith('INSERT INTO `wp_')) continue;
    const tableMatch = line.match(/^INSERT INTO `([^`]+)`/);
    if (!tableMatch) continue;
    const table = tableMatch[1];
    if (!['wp_posts', 'wp_postmeta', 'wp_terms', 'wp_term_taxonomy', 'wp_term_relationships', 'wp_termmeta'].includes(table)) continue;

    for (const row of rowsFromInsert(line)) {
      if (table === 'wp_posts') {
        const obj = objectFromRow(parseSqlRow(row), POST_COLUMNS);
        const id = Number(obj.ID);
        if (obj.post_type === 'product') posts.set(id, obj);
        else if (obj.post_type === 'attachment') attachments.set(id, obj);
        else if (obj.post_type === 'product_variation') {
          const parentId = Number(obj.post_parent);
          if (!variationsByParent.has(parentId)) variationsByParent.set(parentId, []);
          variationsByParent.get(parentId).push(id);
        }
      } else if (table === 'wp_postmeta') {
        const obj = objectFromRow(parseSqlRow(row), POSTMETA_COLUMNS);
        const postId = Number(obj.post_id);
        if (!meta.has(postId)) meta.set(postId, {});
        meta.get(postId)[obj.meta_key] = obj.meta_value;
      } else if (table === 'wp_terms') {
        const obj = objectFromRow(parseSqlRow(row), TERM_COLUMNS);
        terms.set(Number(obj.term_id), obj);
      } else if (table === 'wp_term_taxonomy') {
        const obj = objectFromRow(parseSqlRow(row), TERM_TAXONOMY_COLUMNS);
        termTaxonomies.set(Number(obj.term_taxonomy_id), obj);
      } else if (table === 'wp_term_relationships') {
        const obj = objectFromRow(parseSqlRow(row), TERM_REL_COLUMNS);
        const objectId = Number(obj.object_id);
        if (!relsByObject.has(objectId)) relsByObject.set(objectId, []);
        relsByObject.get(objectId).push(Number(obj.term_taxonomy_id));
      } else if (table === 'wp_termmeta') {
        const obj = objectFromRow(parseSqlRow(row), TERM_META_COLUMNS);
        const termId = Number(obj.term_id);
        if (!termMeta.has(termId)) termMeta.set(termId, {});
        termMeta.get(termId)[obj.meta_key] = obj.meta_value;
      }
    }
  }

  return { posts, attachments, variationsByParent, meta, terms, termTaxonomies, relsByObject, termMeta };
}

function safeMediaName(value) {
  return String(value || 'image')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image';
}

function attachmentRelativePath(id, dump) {
  const attached = String(dump.meta.get(Number(id))?._wp_attached_file || '').replace(/\\/g, '/');
  if (attached) return attached.replace(/^\/+/, '');
  const raw = attachmentUrl(id, dump);
  try {
    const pathname = new URL(raw).pathname;
    const marker = '/wp-content/uploads/';
    const at = pathname.indexOf(marker);
    return at >= 0 ? decodeURIComponent(pathname.slice(at + marker.length)) : '';
  } catch (_) {
    return '';
  }
}

function copyAttachmentOriginal(id, dump, mediaRoot, outputRoot) {
  const relative = attachmentRelativePath(id, dump);
  if (!relative) return null;
  const source = path.resolve(mediaRoot, 'wp-content', 'uploads', ...relative.split('/'));
  const allowedRoot = path.resolve(mediaRoot, 'wp-content', 'uploads');
  if (!source.startsWith(`${allowedRoot}${path.sep}`) || !fs.existsSync(source) || !fs.statSync(source).isFile()) return null;
  const diskName = `wp-${Number(id)}-${safeMediaName(path.basename(source))}`;
  const destinationDir = path.resolve(outputRoot, 'public', 'uploads', 'wordpress');
  fs.mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, diskName);
  if (!fs.existsSync(destination) || fs.statSync(destination).size !== fs.statSync(source).size) {
    fs.copyFileSync(source, destination);
  }
  return `/uploads/wordpress/${encodeURIComponent(diskName)}`;
}

function languageForPost(postId, dump) {
  const rels = dump.relsByObject.get(Number(postId)) || [];
  for (const ttId of rels) {
    const tt = dump.termTaxonomies.get(Number(ttId));
    if (!tt || tt.taxonomy !== 'language') continue;
    const term = dump.terms.get(Number(tt.term_id));
    const slug = String(term?.slug || '').toLowerCase();
    if (VALID_LANGS.has(slug)) return slug;
  }
  return 'en';
}

function buildGroups(dump) {
  const grouped = new Set();
  const groups = [];

  dump.termTaxonomies.forEach((tt) => {
    if (tt.taxonomy !== 'post_translations') return;
    const idsByLang = parseTranslationMap(tt.description);
    const productIds = Object.values(idsByLang).filter((id) => dump.posts.has(Number(id)));
    if (!productIds.length) return;
    productIds.forEach((id) => grouped.add(Number(id)));
    groups.push(idsByLang);
  });

  dump.posts.forEach((_post, id) => {
    if (!grouped.has(Number(id))) groups.push({ [languageForPost(id, dump)]: Number(id) });
  });

  return groups;
}

function attachmentUrl(id, dump) {
  const attachment = dump.attachments.get(Number(id));
  return attachment?.guid || '';
}

function galleryForPost(postId, dump) {
  const postMeta = dump.meta.get(Number(postId)) || {};
  const ids = [];
  if (postMeta._thumbnail_id) ids.push(Number(postMeta._thumbnail_id));
  String(postMeta._product_image_gallery || '').split(',').forEach((id) => {
    const n = Number(id);
    if (n) ids.push(n);
  });

  return [...new Set(ids)].map((id, order) => {
    const url = attachmentUrl(id, dump);
    const attachment = dump.attachments.get(Number(id));
    const attachmentMeta = dump.meta.get(Number(id)) || {};
    return url ? {
      url,
      attachmentId: id,
      alt: attachmentMeta._wp_attachment_image_alt || attachment?.post_title || '',
      order,
    } : null;
  }).filter(Boolean);
}

function taxonomyItemsForGroup(group, dump, type) {
  const taxonomy = type === 'category' ? 'product_cat' : 'product_tag';
  const items = new Map();

  Object.values(group).forEach((postId) => {
    const rels = dump.relsByObject.get(Number(postId)) || [];
    rels.forEach((ttId) => {
      const tt = dump.termTaxonomies.get(Number(ttId));
      if (!tt || tt.taxonomy !== taxonomy) return;
      const term = dump.terms.get(Number(tt.term_id));
      if (!term) return;
      const slug = slugify(term.slug || term.name);
      if (!slug || slug === 'uncategorized') return;
      if (!items.has(slug)) {
        items.set(slug, {
          type,
          name: term.name || slug,
          slug,
          description: tt.description || '',
          sourceTermId: Number(term.term_id),
          sourceTermTaxonomyId: Number(tt.term_taxonomy_id),
          imageAttachmentId: Number(dump.termMeta.get(Number(term.term_id))?.thumbnail_id) || null,
        });
      }
    });
  });

  return [...items.values()];
}

function contentForGroup(group, dump, importedFrom) {
  const ids = Object.values(group).filter(Boolean).map(Number);
  const preferredId = Number(group.en || ids[0]);
  const preferredPost = dump.posts.get(preferredId) || ids.map((id) => dump.posts.get(id)).find(Boolean);
  if (!preferredPost || /^auto-draft$/i.test(String(preferredPost.post_title || '').trim())) return null;
  const skus = ids.flatMap((id) => {
    const ownSku = dump.meta.get(id)?._sku;
    const variationSkus = (dump.variationsByParent.get(id) || [])
      .map((variationId) => dump.meta.get(variationId)?._sku);
    return [ownSku, ...variationSkus].filter(isUsableSku);
  });
  const firstSku = skus.find(Boolean);
  const needsCodeMapping = !firstSku;
  const code = needsCodeMapping ? `UNMAPPED-WP-${preferredId}` : normalizeProductCode(firstSku);
  if (!code) return null;

  const fields = {
    code,
    status: needsCodeMapping ? 'draft' : (ids.some((id) => dump.posts.get(id)?.post_status === 'publish') ? 'published' : 'draft'),
    source: {
      wordpressIds: { en: null, ar: null, fa: null },
      wordpressSkus: [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))],
      needsCodeMapping,
      importedAt: new Date(),
      importedFrom,
    },
  };

  ids.forEach((postId) => {
    const post = dump.posts.get(Number(postId));
    if (!post) return;
    const lang = Object.entries(group).find(([, id]) => Number(id) === Number(postId))?.[0] || languageForPost(postId, dump);
    const safeLang = VALID_LANGS.has(lang) ? lang : 'en';
    const postMeta = dump.meta.get(Number(postId)) || {};

    fields.source.wordpressIds[safeLang] = Number(postId);
    setLangField(fields, 'title', safeLang, post.post_title);
    setLangField(fields, 'excerpt', safeLang, post.post_excerpt);
    setLangField(fields, 'body', safeLang, sanitizeHtml(String(post.post_content || '')));
    setLangField(fields, 'slug', safeLang, post.post_name || slugify(post.post_title || code));

    if (!fields.seo) fields.seo = {};
    if (safeLang === 'ar') {
      fields.seo.metaTitleAr = postMeta._yoast_wpseo_title || '';
      fields.seo.metaDescriptionAr = postMeta._yoast_wpseo_metadesc || '';
    } else if (safeLang === 'fa') {
      fields.seo.metaTitleFa = postMeta._yoast_wpseo_title || '';
      fields.seo.metaDescriptionFa = postMeta._yoast_wpseo_metadesc || '';
    } else {
      fields.seo.metaTitle = postMeta._yoast_wpseo_title || '';
      fields.seo.metaDescription = postMeta._yoast_wpseo_metadesc || '';
    }

    if (!fields.gallery?.length) fields.gallery = galleryForPost(postId, dump);
  });

  if (!fields.title) fields.title = fields.titleAr || fields.titleFa || code;
  if (!fields.slug) fields.slug = slugify(fields.title || code) || code.toLowerCase();
  fields.updateDate = new Date();
  return fields;
}

function hasDirectSku(group, dump) {
  return Object.values(group).filter(Boolean)
    .some((id) => isUsableSku(dump.meta.get(Number(id))?._sku));
}

function dedupeByProductCode(items, dump) {
  const selected = new Map();
  const collisions = [];
  items.forEach((item) => {
    const current = selected.get(item.content.code);
    if (!current) {
      selected.set(item.content.code, item);
      return;
    }
    const score = (candidate) => (candidate.content.status === 'published' ? 2 : 0)
      + (hasDirectSku(candidate.group, dump) ? 1 : 0);
    const keep = score(item) > score(current) ? item : current;
    const skip = keep === item ? current : item;
    selected.set(item.content.code, keep);
    const wordpressId = skip.content.source.wordpressIds.en
      || skip.content.source.wordpressIds.ar
      || skip.content.source.wordpressIds.fa;
    const fallbackCode = `UNMAPPED-WP-${wordpressId}`;
    const preserved = {
      ...skip,
      content: {
        ...skip.content,
        code: fallbackCode,
        status: 'draft',
        source: { ...skip.content.source, needsCodeMapping: true },
      },
    };
    selected.set(fallbackCode, preserved);
    collisions.push({ code: item.content.code, keep, skip: preserved });
  });
  return { contents: [...selected.values()], collisions };
}

async function upsertTaxonomy(Model, item, dryRun) {
  if (dryRun) return { _id: `${item.type}:${item.slug}` };
  const existing = await Model.findOne({ type: item.type, slug: item.slug, deleteDate: null });
  const now = new Date();
  if (existing) {
    existing.name = item.name || existing.name;
    existing.description = item.description || existing.description;
    existing.source = existing.source || {};
    existing.source.importedAt = now;
    existing.source.wordpressTermIds = [...new Set([...(existing.source.wordpressTermIds || []), item.sourceTermId].filter(Boolean))];
    existing.source.wordpressTermTaxonomyIds = [...new Set([...(existing.source.wordpressTermTaxonomyIds || []), item.sourceTermTaxonomyId].filter(Boolean))];
    if (item.image?.url) existing.image = item.image;
    existing.updateDate = now;
    await existing.save();
    return existing;
  }
  return await Model.create({
    type: item.type,
    name: item.name,
    slug: item.slug,
    description: item.description || '',
    ...(item.image?.url ? { image: item.image } : {}),
    source: {
      wordpressTermIds: [item.sourceTermId].filter(Boolean),
      wordpressTermTaxonomyIds: [item.sourceTermTaxonomyId].filter(Boolean),
      importedAt: now,
    },
    insertDate: now,
    updateDate: now,
  });
}

async function run() {
  const sqlPath = path.resolve(argValue('--sql') || DEFAULT_SQL);
  const mediaRoot = path.resolve(argValue('--media-root') || DEFAULT_MEDIA_ROOT);
  const dryRun = !process.argv.includes('--yes');
  const limit = Number(argValue('--limit')) || 0;
  if (!fs.existsSync(sqlPath)) {
    console.error(`SQL file not found: ${sqlPath}`);
    process.exit(1);
  }
  if (!dryRun && !fs.existsSync(mediaRoot)) {
    console.error(`WordPress public folder not found: ${mediaRoot}`);
    process.exit(1);
  }
  if (!dryRun && !process.env.DB_CONNECT) {
    console.error('DB_CONNECT is not set. Add api/.env or run with an environment DB_CONNECT.');
    process.exit(1);
  }

  console.log(`Reading WordPress dump: ${sqlPath}`);
  const dump = await parseDump(sqlPath);
  const groups = buildGroups(dump);
  const groupedContents = groups.map((g) => ({ group: g, content: contentForGroup(g, dump, sqlPath) }));
  const importable = groupedContents.filter((x) => x.content);
  const { contents, collisions } = dedupeByProductCode(importable, dump);
  const missing = groupedContents.filter((x) => !x.content);
  const selected = limit > 0 ? contents.slice(0, limit) : contents;

  console.log(`Found ${dump.posts.size} WooCommerce product post(s), ${contents.length} importable product code record(s).`);
  console.log(dryRun ? 'Dry run only. Add --yes to write to MongoDB.' : 'Writing to MongoDB.');

  if (dryRun) {
    selected.forEach(({ content }) => {
      console.log(`  ${content.code}: ${content.title} (${content.status})`);
    });
    if (missing.length) {
      console.log(`Skipped ${missing.length} non-product draft group(s):`);
      missing.forEach(({ group }) => {
        const ids = Object.values(group).filter(Boolean).map(Number);
        const post = ids.map((id) => dump.posts.get(id)).find(Boolean);
        console.log(`  ${ids.join('/')}: ${post?.post_title || '(untitled)'}`);
      });
    }
    if (collisions.length) {
      console.log(`Resolved ${collisions.length} duplicate product-code mapping(s):`);
      collisions.forEach(({ code, keep, skip }) => {
        console.log(`  ${code}: kept "${keep.content.title}"; preserved "${skip.content.title}" as ${skip.content.code}`);
      });
    }
    return;
  }

  const conn = await mongoose.createConnection(process.env.DB_CONNECT).asPromise();
  const ProductContent = conn.model('websiteProductContent', productContentSchema);
  const ProductTaxonomy = conn.model('websiteProductTaxonomy', productTaxonomySchema);

  let upsertedProducts = 0;
  let copiedMedia = 0;
  const taxonomyCache = new Map();
  for (const { group, content } of selected) {
    const categoryIds = [];
    const tagIds = [];
    for (const item of [...taxonomyItemsForGroup(group, dump, 'category'), ...taxonomyItemsForGroup(group, dump, 'tag')]) {
      if (item.imageAttachmentId) {
        const imageUrl = copyAttachmentOriginal(item.imageAttachmentId, dump, mediaRoot, path.resolve(__dirname, '..'));
        if (imageUrl) {
          item.image = { url: imageUrl, attachmentId: item.imageAttachmentId, alt: item.name || '' };
          copiedMedia += 1;
        }
      }
      const key = `${item.type}:${item.slug}`;
      if (!taxonomyCache.has(key)) taxonomyCache.set(key, await upsertTaxonomy(ProductTaxonomy, item, false));
      const doc = taxonomyCache.get(key);
      if (item.type === 'category') categoryIds.push(doc._id);
      else tagIds.push(doc._id);
    }

    const existing = await ProductContent.findOne({ code: content.code, deleteDate: null });
    const now = new Date();
    const payload = {
      ...content,
      gallery: (content.gallery || []).map((image) => {
        const localUrl = image.attachmentId
          ? copyAttachmentOriginal(image.attachmentId, dump, mediaRoot, path.resolve(__dirname, '..'))
          : null;
        if (localUrl) copiedMedia += 1;
        return { ...image, url: localUrl || image.url };
      }),
      categories: categoryIds,
      tags: tagIds,
      publishedAt: content.status === 'published' ? now : null,
      updateDate: now,
    };
    if (existing) {
      Object.assign(existing, payload);
      await existing.save();
    } else {
      await ProductContent.create({ ...payload, insertDate: now });
    }
    upsertedProducts += 1;
  }

  console.log(`Imported ${upsertedProducts} product content record(s), ${taxonomyCache.size} taxonomy item(s), and resolved ${copiedMedia} media reference(s).`);
  await conn.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
