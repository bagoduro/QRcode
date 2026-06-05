import { MongoClient } from 'mongodb';

const getMongoDbName = () => process.env.MONGO_DB_NAME || 'leitor_qr';

let client;
let db;

export async function getDb() {
  if (db) {
    return db;
  }

  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
  if (!client) {
    client = new MongoClient(MONGO_URI);
  }

  await client.connect();
  db = client.db(getMongoDbName());
  return db;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}
