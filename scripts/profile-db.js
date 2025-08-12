// scripts/profile-db.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }
  const dbName = process.env.DB_NAME || process.env.MONGODB_DB || 'patchproof';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const cmd = process.argv[2] || 'status';

  if (cmd === 'enable') {
    const ms = Number(process.argv[3] || 50); // default threshold 50ms
    await db.command({ profile: 1, slowms: ms });
    console.log(`Profiler enabled at level 1 with slowms=${ms}ms`);
  } else if (cmd === 'full') {
    await db.command({ profile: 2 });
    console.log('Profiler enabled at level 2 (all operations)');
  } else if (cmd === 'disable') {
    await db.command({ profile: 0 });
    console.log('Profiler disabled');
  } else if (cmd === 'slow') {
    const profile = db.collection('system.profile');
    const limit = Number(process.argv[3] || 10);
    const docs = await profile.find({ millis: { $gt: 0 } }).sort({ ts: -1 }).limit(limit).toArray();
    console.log(`Last ${docs.length} profiled ops:`);
    for (const d of docs) {
      console.log(JSON.stringify({ ns: d.ns, op: d.op, millis: d.millis, ts: d.ts, query: d.query || d.command }, null, 2));
    }
  } else if (cmd === 'indexes') {
    // Print indexes on key collections
    const colls = ['AuthenticationRecord', 'PatchState', 'Utxo'];
    for (const c of colls) {
      const idx = await db.collection(c).indexes();
      console.log(`\nIndexes for ${c}:`);
      for (const i of idx) console.log(JSON.stringify(i));
    }
  } else {
    const status = await db.command({ profile: -1 });
    console.log('Profiler status:', status);
    console.log('\nUsage:');
    console.log('  node scripts/profile-db.js enable [slowms]');
    console.log('  node scripts/profile-db.js full');
    console.log('  node scripts/profile-db.js disable');
    console.log('  node scripts/profile-db.js slow [limit]');
    console.log('  node scripts/profile-db.js indexes');
  }

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
