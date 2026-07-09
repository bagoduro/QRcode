import { getDb } from './db.js';

// ─── MODEL: User ─────────────────────────────────────────────────────────────
// Encapsula todo o acesso à collection "users".

async function collection() {
  const db = await getDb();
  return db.collection('users');
}

export async function findByUsername(usernameLower) {
  const col = await collection();
  return col.findOne({ username: usernameLower });
}

export async function findByIdSafe(id) {
  const col = await collection();
  return col.findOne({ _id: id }, { projection: { password_hash: 0, salt: 0 } });
}

export async function createUser({ username, password_hash, salt }) {
  const col = await collection();
  return col.insertOne({ username, password_hash, salt, createdAt: new Date() });
}
