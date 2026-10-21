// How a CRM customer is reached, found and classified — the rules the customer routes (and the daily report) share.
//
//   contact      A customer is reached through a phone number and/or other channels (WhatsApp, a second phone,
//                e-mail, Telegram, Instagram). At least ONE of them has to be given: a lead can be captured with
//                whichever the person has at hand, not only a phone number.
//   duplicates   Two records for one person is what the first-contact check exists to prevent. Every identifier
//                that was given is compared with the SAME kind of identifier on the other customers (a phone with
//                phones, an e-mail with e-mails ...); numbers by their digits, so "+971 50 123 4567" and
//                "971501234567" are one number, handles without case or a leading "@".
//   kind         "cash" (paid on the spot) or "regular". A cash customer's status is always "won".
'use strict';

const HANDLE_CHANNELS = ['whatsApp', 'phone', 'email', 'telegram', 'instagram'];
const CUSTOMER_KINDS = ['cash', 'regular'];
const CASH_STATUS = 'won';

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** { phoneNumber, handles: { channel: 'trimmed value' } } from the two places a customer keeps them (empty ones dropped). */
function contactsOf({ phoneNumber, commHandles } = {}) {
  const handles = {};
  if (commHandles && typeof commHandles === 'object') {
    Object.entries(commHandles).forEach(([channel, value]) => {
      const v = clean(value);
      if (v) handles[channel] = v;
    });
  }
  return { phoneNumber: clean(phoneNumber), handles };
}

const hasContact = (contacts) => Boolean(contacts.phoneNumber) || Object.keys(contacts.handles).length > 0;

/** The pattern a stored handle of this channel must match to be the same one, or null when the value is too short to compare. */
function handleRegex(channel, value) {
  if (channel === 'whatsApp' || channel === 'phone') {
    const digits = digitsOf(value);
    if (digits.length < 5) return null;                     // not a number worth comparing
    return new RegExp(`^\\D*${digits.split('').join('\\D*')}\\D*$`);
  }
  const text = clean(value).replace(/^@/, '');
  if (!text) return null;
  return new RegExp(`^\\s*@?${escapeRegex(text)}\\s*$`, 'i');
}

const nameOf = (c) => {
  const p = (c && c.personalInformation) || {};
  return p.customerType === 'company' || p.personOrCompany === 'company'
    ? (p.companyName || '')
    : `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.companyName || '';
};

/** What to call a customer when it has no name: its first phone / handle. */
function contactLabel(c) {
  if (!c) return '';
  const name = nameOf(c);
  if (name) return name;
  if (c.phoneNumber) return String(c.phoneNumber);
  const handles = (c.commHandles && typeof c.commHandles === 'object') ? Object.values(c.commHandles) : [];
  return clean(handles.find((v) => clean(v))) || '';
}

/**
 * The first OTHER customer who already has one of these identifiers: { customer, channel } or null.
 * `channel` is 'phoneNumber' or the handle's channel.
 */
async function findContactDuplicate(Customer, contacts, excludeId = null) {
  const or = [];
  if (contacts.phoneNumber) or.push({ phoneNumber: contacts.phoneNumber });
  HANDLE_CHANNELS.forEach((channel) => {
    const re = handleRegex(channel, contacts.handles[channel]);
    if (re) or.push({ [`commHandles.${channel}`]: re });
  });
  if (!or.length) return null;

  const query = { deleteDate: null, $or: or };
  if (excludeId) query._id = { $ne: excludeId };
  const match = await Customer.findOne(query).select('personalInformation phoneNumber commHandles').lean();
  if (!match) return null;

  let channel = 'phoneNumber';
  if (!(contacts.phoneNumber && match.phoneNumber === contacts.phoneNumber)) {
    channel = HANDLE_CHANNELS.find((ch) => {
      const re = handleRegex(ch, contacts.handles[ch]);
      return re && re.test(String((match.commHandles || {})[ch] || ''));
    }) || 'phoneNumber';
  }
  return { customer: match, channel };
}

/** 'cash' | 'regular' | '' (not set), or { error } for anything else. `undefined` (not sent) stays undefined. */
function readCustomerKind(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return '';
  return CUSTOMER_KINDS.includes(raw) ? raw : { error: `customerKind must be one of: ${CUSTOMER_KINDS.join(', ')}` };
}

module.exports = {
  HANDLE_CHANNELS, CUSTOMER_KINDS, CASH_STATUS,
  contactsOf, hasContact, handleRegex, contactLabel, nameOf, findContactDuplicate, readCustomerKind,
};
