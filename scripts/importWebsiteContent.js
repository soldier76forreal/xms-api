/**
 * importWebsiteContent.js — puts the public website's content into a deployment's
 * database, from the files scripts/exportWebsiteContent.js produced.
 *
 *   websiteproductcontents     the product pages
 *   websiteproducttaxonomies   the categories and tags they point at
 *   blogposts                  the blog (OPT-IN, see --with-blog)
 *
 * It upserts by _id and NEVER deletes. _id is preserved deliberately: a product
 * page holds its categories and tags as ObjectId references into the taxonomy
 * collection, so re-keying either side would strip every page's categories.
 *
 * Re-running it is safe — a second run updates in place rather than duplicating.
 *
 * Dry run unless --yes, and the dry run is the useful part: it reports what
 * would be inserted and what updated, any slug that is already taken by a
 * DIFFERENT record (the unique index would reject that, so it is reported
 * before anything is written rather than failing half way), which product pages
 * match no Inventory product in the TARGET database, and which referenced
 * images are missing from public/uploads on this machine.
 *
 * Usage (from api/):
 *   node scripts/importWebsiteContent.js --db "<uri>"              dry run
 *   node scripts/importWebsiteContent.js --db "<uri>" --yes        apply
 *   node scripts/importWebsiteContent.js --db "<uri>" --yes --with-blog
 *   node scripts/importWebsiteContent.js --db "<uri>" --yes --published-only
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── arguments / environment ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--yes');
const WITH_BLOG = argv.includes('--with-blog');
const PUBLISHED_ONLY = argv.includes('--published-only');
const dbAt = argv.indexOf('--db');
const DB_OVERRIDE = dbAt === -1 ? null : argv[dbAt + 1];
if (dbAt !== -1 && (!DB_OVERRIDE || DB_OVERRIDE.startsWith('--'))) {
  console.error('--db needs a MongoDB connection string, e.g. --db "mongodb://127.0.0.1:27017/xms"');
  process.exit(1);
}
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (DB_OVERRIDE) process.env.DB_CONNECT = DB_OVERRIDE;
if (!process.env.DB_CONNECT) {
  console.error('DB_CONNECT is not set. Put it in api/.env or pass --db "<mongodb uri>"');
  process.exit(1);
}

const mongoose = require('mongoose');
const { EJSON } = require('bson');

const DATA_DIR = path.join(__dirname, 'websiteContentData');
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

function load(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.error(`missing data file: ${file}\nRun scripts/exportWebsiteContent.js on the source machine first.`);
    process.exit(1);
  }
  return EJSON.parse(fs.readFileSync(file, 'utf8'), { relaxed: false });
}

(async () => {
  const conn = await mongoose.createConnection(process.env.DB_CONNECT).asPromise();
  const db = conn.getClient().db();

  console.log(`database : ${db.databaseName}`);
  console.log(`mode     : ${APPLY ? 'APPLY' : 'dry run (add --yes to write)'}`);
  console.log(`blog     : ${WITH_BLOG ? 'included' : 'skipped (pass --with-blog to include it)'}`);
  if (PUBLISHED_ONLY) console.log('pages    : published only (drafts left behind)');
  console.log('');

  const plan = [
    { col: 'websiteproducttaxonomies', docs: load('websiteproducttaxonomies'), key: ['type', 'slug'] },
    { col: 'websiteproductcontents', docs: load('websiteproductcontents'), key: ['slug'] },
  ];
  if (WITH_BLOG) plan.push({ col: 'blogposts', docs: load('blogposts'), key: ['slug'] });

  if (PUBLISHED_ONLY) {
    const pc = plan.find((p) => p.col === 'websiteproductcontents');
    const before = pc.docs.length;
    pc.docs = pc.docs.filter((d) => d.status === 'published');
    console.log(`dropped ${before - pc.docs.length} draft page(s) from this run`);
  }

  // ── pre-flight: what would happen, and anything that would be rejected ─────
  let blocked = 0;
  for (const step of plan) {
    const col = db.collection(step.col);
    let insert = 0; let update = 0;
    const collisions = [];
    for (const doc of step.docs) {
      const byId = await col.findOne({ _id: doc._id }, { projection: { _id: 1 } });
      if (byId) update++; else insert++;

      // The unique index is on the natural key, not on _id. A record already sitting
      // on this slug under a DIFFERENT _id would make the write fail, so say so now.
      const filter = {};
      for (const k of step.key) filter[k] = doc[k];
      if (Object.values(filter).every((v) => v === undefined || v === null || v === '')) continue;
      const clash = await col.findOne({ ...filter, _id: { $ne: doc._id } }, { projection: { _id: 1 } });
      if (clash) collisions.push({ key: JSON.stringify(filter), mine: String(doc._id), theirs: String(clash._id) });
    }
    console.log(`${step.col.padEnd(26)} ${String(step.docs.length).padStart(4)} in file → ${insert} new, ${update} updated`);
    for (const c of collisions) {
      blocked++;
      console.log(`   CLASH ${c.key} is already used by ${c.theirs} (the file has it as ${c.mine})`);
    }
  }
  if (blocked) {
    console.log(`\n${blocked} record(s) would be rejected by a unique index.`);
    console.log('Nothing has been written. Resolve those first — they mean this database already');
    console.log('holds website content from a different export.');
    await conn.close();
    process.exit(1);
  }

  // ── write ──────────────────────────────────────────────────────────────────
  if (APPLY) {
    console.log('');
    for (const step of plan) {
      const col = db.collection(step.col);
      const ops = step.docs.map((doc) => ({
        replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
      }));
      if (!ops.length) continue;
      const res = await col.bulkWrite(ops, { ordered: false });
      console.log(`${step.col.padEnd(26)} inserted ${res.upsertedCount}, replaced ${res.modifiedCount}`);
    }

    // These writes go through the raw driver, so Mongoose has not compiled the models
    // and a brand-new database would be left with nothing but _id_. The app builds them
    // on its first start, but a deployment should not have to rely on that order - a
    // duplicate slug could be written in the meantime. Build them from the app's own
    // schemas, which is the single source of truth for what they should be.
    console.log('');
    const schemas = {
      websiteproductcontents: ['websiteProductContent', require('../models/websiteProductContentModel')],
      websiteproducttaxonomies: ['websiteProductTaxonomy', require('../models/websiteProductTaxonomyModel')],
      blogposts: ['blogPost', require('../models/blogPostModel')],
    };
    for (const step of plan) {
      const entry = schemas[step.col];
      if (!entry) continue;
      const [name, schema] = entry;
      const Model = conn.models[name] || conn.model(name, schema);
      try {
        await Model.createIndexes();
        const built = (await db.collection(step.col).indexes()).map((i) => i.name).filter((n) => n !== '_id_');
        console.log(`${step.col.padEnd(26)} indexes: ${built.join(', ') || '(none declared)'}`);
      } catch (err) {
        // An index that cannot be built is worth knowing about, but the content is already in.
        console.log(`${step.col.padEnd(26)} INDEX PROBLEM: ${err.message}`);
      }
    }
  }

  // ── report: the two things that silently break a deployed site ────────────
  console.log('\n--- product pages against THIS database\'s inventory ---');
  const codes = new Set((await db.collection('inventoryproducts').find({}, { projection: { code: 1 } }).toArray())
    .map((p) => String(p.code || '').toUpperCase()).filter(Boolean));
  console.log(`inventory product codes here: ${codes.size}`);
  const pages = plan.find((p) => p.col === 'websiteproductcontents').docs;
  const orphan = pages.filter((d) => d.status === 'published' && !codes.has(String(d.code || '').toUpperCase()));
  console.log(`published pages: ${pages.filter((d) => d.status === 'published').length} · without a matching product: ${orphan.length}`);
  for (const o of orphan) console.log(`   ${String(o.code).padEnd(10)} ${o.slug}   (page renders, varieties table and stock come out empty)`);

  console.log('\n--- images these records point at ---');
  const refsFile = path.join(DATA_DIR, 'imageReferences.json');
  if (fs.existsSync(refsFile)) {
    const refs = JSON.parse(fs.readFileSync(refsFile, 'utf8'));
    const missing = [];
    let external = 0; let present = 0;
    for (const u of refs) {
      if (/^https?:\/\//i.test(u)) { external++; continue; }
      if (!u.startsWith('/uploads/')) continue;
      const f = path.join(UPLOADS_DIR, decodeURIComponent(u.slice('/uploads/'.length)).split('?')[0]);
      if (fs.existsSync(f)) present++; else missing.push(u);
    }
    console.log(`found in public/uploads on this machine: ${present}`);
    console.log(`loaded from another host (not yours)   : ${external}`);
    console.log(`MISSING from public/uploads            : ${missing.length}`);
    for (const m of missing.slice(0, 15)) console.log(`   ${m}`);
    if (missing.length > 15) console.log(`   … and ${missing.length - 15} more`);
    if (missing.length) console.log('   → upload the gallery images (api/public/uploads/wordpress) before going live.');
  }

  if (!APPLY) console.log('\nDry run. Nothing was written. Re-run with --yes to apply.');
  await conn.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
