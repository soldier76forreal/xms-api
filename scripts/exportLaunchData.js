/**
 * exportLaunchData.js — one-time helper for the 2026-07 launch.
 * Exports the NEW app's config collections (permissions catalog, roles,
 * company profile) from the LOCAL dev DB into scripts/launchData/*.json,
 * where launchMigration.js picks them up when it runs on the server.
 *
 * Usage: node scripts/exportLaunchData.js   (from /api, local machine)
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

const LOCAL_URI = 'mongodb://localhost:27017/xms';
const OUT_DIR = path.join(__dirname, 'launchData');

(async () => {
  const conn = await mongoose.createConnection(LOCAL_URI).asPromise();
  const db = conn.getClient().db();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const col of ['permissions', 'roles', 'companyprofiles']) {
    const docs = await db.collection(col).find({}).toArray();
    fs.writeFileSync(
      path.join(OUT_DIR, `${col}.json`),
      EJSON.stringify(docs, null, 2, { relaxed: false })
    );
    console.log(`${col}: ${docs.length} docs exported`);
  }

  await conn.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
