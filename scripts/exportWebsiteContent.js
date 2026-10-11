/**
 * exportWebsiteContent.js — takes the PUBLIC WEBSITE's content out of a database
 * and writes it to scripts/websiteContentData/, where importWebsiteContent.js
 * picks it up on the deployment server.
 *
 * What it exports, and why only these three:
 *   websiteproductcontents     the product pages (title/description/SEO per
 *                              language, slug, gallery, categories, tags)
 *   websiteproducttaxonomies   the categories and tags those pages point AT -
 *                              product content references them by _id, so the
 *                              two have to travel together or the pages lose
 *                              their categories
 *   blogposts                  the website's blog
 *
 * Deliberately NOT exported, because they are a deployment's own live data and
 * copying them over would be wrong:
 *   pricerequests            real customer purchase requests
 *   websiteanalyticsevents   traffic measured on THIS site
 *   websiteemailotps         one-time codes, seconds of validity
 *   websiteproductpreviews   short-lived editor previews (TTL collection)
 *
 * _id values are preserved on purpose — see the taxonomy note above.
 *
 * Usage (from api/):
 *   node scripts/exportWebsiteContent.js                     export from DB_CONNECT
 *   node scripts/exportWebsiteContent.js --db "<mongodb uri>"
 */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const dbAt = argv.indexOf('--db');
const DB_OVERRIDE = dbAt === -1 ? null : argv[dbAt + 1];
if (dbAt !== -1 && (!DB_OVERRIDE || DB_OVERRIDE.startsWith('--'))) {
  console.error('--db needs a MongoDB connection string, e.g. --db "mongodb://localhost:27017/xms"');
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

const OUT_DIR = path.join(__dirname, 'websiteContentData');
const COLLECTIONS = ['websiteproductcontents', 'websiteproducttaxonomies', 'blogposts'];

(async () => {
  const conn = await mongoose.createConnection(process.env.DB_CONNECT).asPromise();
  const db = conn.getClient().db();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = {
    exportedAt: new Date().toISOString(),
    sourceDatabase: db.databaseName,
    collections: {},
  };

  for (const col of COLLECTIONS) {
    const docs = await db.collection(col).find({}).toArray();
    fs.writeFileSync(
      path.join(OUT_DIR, `${col}.json`),
      EJSON.stringify(docs, null, 2, { relaxed: false }),
    );
    manifest.collections[col] = docs.length;
    console.log(`${col.padEnd(26)} ${String(docs.length).padStart(4)} documents`);
  }

  // The things an importer should know before it runs, worked out here while the
  // source database is at hand rather than guessed at on the server.
  const pcs = await db.collection('websiteproductcontents').find({}).toArray();
  const codes = new Set((await db.collection('inventoryproducts').find({}, { projection: { code: 1 } }).toArray())
    .map((p) => String(p.code || '').toUpperCase()).filter(Boolean));

  manifest.productPages = {
    total: pcs.length,
    published: pcs.filter((d) => d.status === 'published').length,
    draft: pcs.filter((d) => d.status === 'draft').length,
    // A page is keyed by an Inventory product code. Where the code matches nothing,
    // the page still renders but its varieties table and stock come out empty.
    publishedWithoutAProduct: pcs
      .filter((d) => d.status === 'published' && !codes.has(String(d.code || '').toUpperCase()))
      .map((d) => ({ code: d.code, slug: d.slug })),
    draftPlaceholderCodes: pcs.filter((d) => /^UNMAPPED-WP-/i.test(String(d.code || ''))).length,
  };

  // Every image these records point at, so the media can be checked against the files
  // actually uploaded to the server.
  const imageRefs = new Set();
  const noteHtml = (v) => {
    const texts = typeof v === 'string' ? [v] : (v && typeof v === 'object' ? Object.values(v) : []);
    for (const t of texts) {
      if (typeof t !== 'string') continue;
      for (const m of t.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:jpe?g|png|gif|webp|svg|avif))["']/gi)) imageRefs.add(m[1]);
    }
  };
  for (const d of pcs) {
    for (const g of (d.gallery || [])) if (g && g.url) imageRefs.add(g.url);
    for (const k of ['body', 'bodyAr', 'bodyFa', 'excerpt', 'excerptAr', 'excerptFa']) noteHtml(d[k]);
  }
  for (const d of await db.collection('websiteproducttaxonomies').find({}).toArray()) {
    if (d.image && d.image.url) imageRefs.add(d.image.url);
  }
  const refs = [...imageRefs];
  manifest.images = {
    distinctReferences: refs.length,
    underApiUploads: refs.filter((u) => u.startsWith('/uploads/')).length,
    // An absolute URL points somewhere this deployment does not control - it will keep
    // loading from that other host, or break if that host goes away.
    absoluteUrls: refs.filter((u) => /^https?:\/\//i.test(u)),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'imageReferences.json'), JSON.stringify(refs.sort(), null, 2));

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest.json + imageReferences.json written to ${OUT_DIR}`);
  console.log(`product pages: ${manifest.productPages.published} published, ${manifest.productPages.draft} draft`);
  if (manifest.productPages.publishedWithoutAProduct.length) {
    console.log('published pages whose code matches no inventory product in THIS database:');
    for (const p of manifest.productPages.publishedWithoutAProduct) console.log(`   ${String(p.code).padEnd(10)} ${p.slug}`);
  }
  if (manifest.images.absoluteUrls.length) {
    console.log('images loaded from another host (they will not come across with the upload):');
    for (const u of manifest.images.absoluteUrls) console.log(`   ${u}`);
  }

  await conn.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
