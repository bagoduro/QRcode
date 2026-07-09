import { getDb } from './db.js';

// ─── MODEL: Purchase ─────────────────────────────────────────────────────────
// Encapsula todo o acesso à collection "purchases" (as notas fiscais salvas).

async function collection() {
  const db = await getDb();
  return db.collection('purchases');
}

export async function findByUrl(url) {
  const col = await collection();
  return col.findOne({ url });
}

export async function insertPurchase(purchase) {
  const col = await collection();
  return col.insertOne(purchase);
}

export async function deleteByUrl(url) {
  const col = await collection();
  return col.deleteOne({ url });
}

export async function countAll() {
  const col = await collection();
  return col.countDocuments({});
}

export async function findPage(skip, limit, projection) {
  const col = await collection();
  let cursor = col.find({}, projection ? { projection } : undefined);
  if (skip) cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);
  return cursor;
}

export async function updateItemsDescription(descOriginal, novaDescricao, novaDescricaoNorm, productId) {
  const col = await collection();
  return col.updateMany(
    { 'itens.descricao': descOriginal },
    {
      $set: {
        'itens.$[elem].descricao': novaDescricao,
        'itens.$[elem].descricao_normalizada': novaDescricaoNorm,
        'itens.$[elem].product_id': productId,
      },
    },
    { arrayFilters: [{ 'elem.descricao': descOriginal }] }
  );
}

export async function preserveOriginalDescription(descOriginal) {
  const col = await collection();
  return col.updateMany(
    { 'itens.descricao': descOriginal, 'itens.descricao_original': { $exists: false } },
    { $set: { 'itens.$[elem].descricao_original': descOriginal } },
    { arrayFilters: [{ 'elem.descricao': descOriginal }] }
  );
}

export async function restoreItemsByOriginalDescription(descOriginal, descOriginalNorm, productId) {
  const col = await collection();
  return col.updateMany(
    {},
    {
      $set: {
        'itens.$[elem].descricao': descOriginal,
        'itens.$[elem].descricao_normalizada': descOriginalNorm,
        'itens.$[elem].product_id': productId,
      },
      $unset: { 'itens.$[elem].descricao_original': '' },
    },
    { arrayFilters: [{ 'elem.descricao_original': descOriginal }] }
  );
}

export async function updateItensById(purchaseId, itensAtualizados) {
  const col = await collection();
  return col.updateOne({ _id: purchaseId }, { $set: { itens: itensAtualizados } });
}

export async function aggregate(pipeline) {
  const col = await collection();
  return col.aggregate(pipeline).toArray();
}
