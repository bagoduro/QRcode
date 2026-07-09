import { getDb } from './db.js';

// ─── MODEL: Product ──────────────────────────────────────────────────────────
// Encapsula todo o acesso à collection "products". Nenhum outro arquivo do
// projeto deve chamar db.collection('products') diretamente — sempre passa
// por aqui. Isso é o que caracteriza a camada de Model no padrão MVC.

async function collection() {
  const db = await getDb();
  return db.collection('products');
}

export async function findByNormalizedName(nomeNormalizado) {
  const col = await collection();
  return col.findOne({ nome_normalizado: nomeNormalizado });
}

export async function findById(id) {
  const col = await collection();
  return col.findOne({ _id: id });
}

export async function findManyByNormalizedNames(normas) {
  const col = await collection();
  return col.find({ nome_normalizado: { $in: normas } }).toArray();
}

export async function findUnblocked() {
  const col = await collection();
  return col.find({ block_auto_merge: { $ne: true } }).toArray();
}

export async function findAllUnblockedExcluding(id) {
  const col = await collection();
  return col.find({ _id: { $ne: id }, block_auto_merge: { $ne: true } }).toArray();
}

export async function findByBlockedStatus(blocked) {
  const col = await collection();
  return col
    .find({ block_auto_merge: blocked })
    .project({ nome_original: 1, nome_normalizado: 1, block_auto_merge: 1 })
    .toArray();
}

export async function upsertCanonical(nomeNormalizado, nomeOriginal) {
  const col = await collection();
  await col.updateOne(
    { nome_normalizado: nomeNormalizado },
    {
      $setOnInsert: { createdAt: new Date(), codigo: null },
      $set: {
        nome_original: nomeOriginal,
        nome_normalizado: nomeNormalizado,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  return findByNormalizedName(nomeNormalizado);
}

export async function insertNew(item, nomeNormalizado) {
  const col = await collection();
  const doc = {
    createdAt: new Date(),
    codigo: item.codigo || null,
    nome_original: item.descricao,
    nome_normalizado: nomeNormalizado,
    updatedAt: new Date(),
    block_auto_merge: item.block_auto_merge ?? false,
  };
  const result = await col.insertOne(doc);
  return result.insertedId;
}

export async function touchUpdatedAt(id) {
  const col = await collection();
  return col.updateOne({ _id: id }, { $set: { updatedAt: new Date() } });
}

export async function setBlocked(filter, blocked) {
  const col = await collection();
  return col.updateOne(filter, { $set: { block_auto_merge: blocked === true, updatedAt: new Date() } });
}

export async function setBlockedByNormalizedName(nomeNormalizado, blocked) {
  return setBlocked({ nome_normalizado: nomeNormalizado }, blocked);
}

export async function setBlockedById(id, blocked) {
  return setBlocked({ _id: id }, blocked);
}

export async function unblockAll() {
  const col = await collection();
  return col.updateMany({ block_auto_merge: true }, { $set: { block_auto_merge: false } });
}

export async function blockManyByNormalizedNames(normas) {
  const col = await collection();
  return col.updateMany(
    { nome_normalizado: { $in: normas } },
    { $set: { block_auto_merge: true, updatedAt: new Date() } }
  );
}

export async function deleteManyByNormalizedNames(normas) {
  const col = await collection();
  return col.deleteMany({ nome_normalizado: { $in: normas } });
}

export async function upsertOriginalBlocked(nomeOriginal, nomeNormalizado) {
  const col = await collection();
  await col.updateOne(
    { nome_normalizado: nomeNormalizado },
    {
      $setOnInsert: { createdAt: new Date(), codigo: null },
      $set: {
        nome_original: nomeOriginal,
        nome_normalizado: nomeNormalizado,
        updatedAt: new Date(),
        block_auto_merge: true,
      },
    },
    { upsert: true }
  );
  return findByNormalizedName(nomeNormalizado);
}
