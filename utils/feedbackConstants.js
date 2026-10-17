// Shared vocabulary for Report & Info — bug reports and suggestions.
//
// Plain strings validated HERE, deliberately not Mongoose enums: the admin
// panel that follows will add statuses and areas, and that has to be a code
// change, never a schema migration (same reason branch.misTemplates is a
// string). The frontend mirrors TYPES / STATUSES / AREAS in
// xms/src/components/info/ticketMeta.js — change one, change the other.
const TYPES = ['bug', 'suggestion'];

// In the order a ticket normally moves through them.
const STATUSES = ['open', 'in_review', 'planned', 'in_progress', 'done', 'declined'];
const DEFAULT_STATUS = 'open';

// The statuses in which the person who filed a ticket may still change it. Once a
// developer has moved it on, it is part of their workflow and the text stops moving
// underneath them. (Deleting your own is allowed at any status.) Mirrored in
// components/info/ticketMeta.js.
const EDITABLE_STATUSES = ['open'];

// Which part of the app a ticket is about. The keys of the app's sections plus
// the few places that are not one.
const AREAS = [
  'mis', 'crm', 'files', 'inventory', 'people', 'digitalMarketing',
  'jobReports', 'tutorials', 'supply', 'website', 'reportInfo', 'login', 'other',
];

const LIMITS = {
  titleMax: 120,
  descriptionMax: 5000,
  maxFiles: 10,        // pictures, recordings, documents
  maxVoice: 3,         // voice notes recorded in the form
  maxPerHour: 20,      // tickets one person may file per rolling hour
  contextFieldMax: 300,
};

module.exports = { TYPES, STATUSES, DEFAULT_STATUS, EDITABLE_STATUSES, AREAS, LIMITS };
