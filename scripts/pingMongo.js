require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'appdb';

if (!uri) {
  console.error('Missing MONGODB_URI in .env');
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
    console.log(`Pinged MongoDB successfully against DB: ${dbName}`);
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

run();
