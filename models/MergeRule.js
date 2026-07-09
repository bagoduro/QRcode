import { getDb } from './db.js';

// ─── MODEL: MergeRule ────────────────────────────────────────────────────────
// Encapsula todo o acesso à collection "merge_rules" (regras persistentes
// de mesclagem automática/manual de produtos).

async function collection() {
  const db = await getDb();
  return db.collection('merge_rules');
}

export async function findAllSortedByUpdated() {
  const col = await collection();
  return col.find({}).sort({ updatedAt: -1 }).toArray();
}

export async function findAll() {
  const col = await collection();
  return col.find({}).toArray();
}

export async function findByOriginalNormalized(descOriginalNorm) {
  const col = await collection();
  return col.findOne({ descricao_original_normalizada: descOriginalNorm });
}

export async function findByFinalName(nomeFinal) {
  const col = await collection();
  return col.findOne({ nome_final: nomeFinal });
}

export async function findByFinalNormalized(nomeFinalNorm) {
  const col = await collection();
  return col.findOne({ nome_final_normalizado: nomeFinalNorm });
}

export async function findAllByFinalNormalized(nomeFinalNorm) {
  const col = await collection();
  return col.find({ nome_final_normalizado: nomeFinalNorm }).toArray();
}

export async function distinctFinalNormalized() {
  const col = await collection();
  return col.distinct('nome_final_normalizado');
}

export async function distinctOriginalNormalized() {
  const col = await collection();
  return col.distinct('descricao_original_normalizada');
}

export async function upsertRule({ descOriginal, descOriginalNorm, nomeFinal, nomeFinalNorm, productId, origem }) {
  const col = await collection();
  return col.updateOne(
    { descricao_original_normalizada: descOriginalNorm },
    {
      $set: {
        descricao_original: descOriginal,
        descricao_original_normalizada: descOriginalNorm,
        nome_final: nomeFinal,
        nome_final_normalizado: nomeFinalNorm,
        product_id: productId,
        updatedAt: new Date(),
        ...(origem ? { origem } : {}),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

export async function retargetRules(oldNormas, { nomeFinal, nomeFinalNorm, productId }) {
  const col = await collection();
  return col.updateMany(
    { nome_final_normalizado: { $in: oldNormas } },
    {
      $set: {
        nome_final: nomeFinal,
        nome_final_normalizado: nomeFinalNorm,
        product_id: productId,
        updatedAt: new Date(),
      },
    }
  );
}

export async function findActiveByEitherSide(nomeNorm) {
  const col = await collection();
  return col.findOne({
    $or: [{ nome_final_normalizado: nomeNorm }, { descricao_original_normalizada: nomeNorm }],
  });
}

export async function deleteAllByFinalNormalized(nomeFinalNorm) {
  const col = await collection();
  return col.deleteMany({ nome_final_normalizado: nomeFinalNorm });
}
