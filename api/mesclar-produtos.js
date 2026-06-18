import { getDb } from '../db.js';

function normalizeName(text = '') {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = await getDb();
  const purchases  = db.collection('purchases');
  const products   = db.collection('products');
  const mergeLog   = db.collection('merge_log');

  // ── GET: listar histórico de mesclagens ───────────────────────────────────
  if (req.method === 'GET') {
    const historico = await mergeLog.find({}).sort({ createdAt: -1 }).limit(50).toArray();
    return res.json({ total: historico.length, historico });
  }

  // ── DELETE: reverter uma mesclagem ────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Informe o "id" da mesclagem.' });

    const { ObjectId } = await import('mongodb');
    let oid;
    try { oid = new ObjectId(id); } catch { return res.status(400).json({ error: 'ID inválido.' }); }

    const entrada = await mergeLog.findOne({ _id: oid });
    if (!entrada) return res.status(404).json({ error: 'Mesclagem não encontrada.' });

    // Restaurar cada item usando o snapshot salvo
    let notasRevertidas = 0;
    for (const snap of entrada.snapshot) {
      // snap = { purchaseId, itenOriginal: [{idx, descricao, descricao_normalizada, product_id}] }
      for (const itemSnap of snap.itens) {
        const result = await purchases.updateOne(
          { _id: snap.purchaseId },
          {
            $set: {
              [`itens.${itemSnap.idx}.descricao`]:             itemSnap.descricao,
              [`itens.${itemSnap.idx}.descricao_normalizada`]: itemSnap.descricao_normalizada,
              [`itens.${itemSnap.idx}.product_id`]:            itemSnap.product_id,
            },
          }
        );
        if (result.modifiedCount > 0) notasRevertidas++;
      }
    }

    // Recriar os produtos antigos na coleção products
    for (const prod of entrada.produtos_antigos) {
      await products.updateOne(
        { nome_normalizado: prod.nome_normalizado },
        { $setOnInsert: prod },
        { upsert: true }
      );
    }

    // Remover o produto canônico se não era pré-existente
    if (!entrada.nome_final_preexistia) {
      await products.deleteOne({ nome_normalizado: normalizeName(entrada.nome_final) });
    }

    await mergeLog.deleteOne({ _id: oid });

    return res.json({ ok: true, notas_revertidas: notasRevertidas });
  }

  // ── POST: executar mesclagem ───────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const { descricoes, nome_final } = req.body || {};
  if (!Array.isArray(descricoes) || descricoes.length < 2)
    return res.status(400).json({ error: 'Informe ao menos 2 produtos em "descricoes".' });
  if (!nome_final || !nome_final.trim())
    return res.status(400).json({ error: 'Informe o "nome_final".' });

  const nomeFinal     = nome_final.trim();
  const nomeFinalNorm = normalizeName(nomeFinal);

  // Verificar se o nome final já existia antes da mesclagem
  const nomeFinalPreexistia = !!(await products.findOne({ nome_normalizado: nomeFinalNorm }));

  // Salvar snapshot dos produtos antigos antes de deletar
  const produtosAntigos = await products.find({
    nome_normalizado: {
      $in: descricoes
        .map(normalizeName)
        .filter((n) => n !== nomeFinalNorm),
    },
  }).toArray();

  // Salvar snapshot dos itens afetados nas purchases (para reverter depois)
  const snapshot = [];
  for (const descricao of descricoes) {
    const comprasAfetadas = await purchases.find({ 'itens.descricao': descricao }).toArray();
    for (const compra of comprasAfetadas) {
      const itensSnap = compra.itens
        .map((item, idx) => ({ idx, descricao: item.descricao, descricao_normalizada: item.descricao_normalizada, product_id: item.product_id }))
        .filter((item) => item.descricao === descricao);
      if (itensSnap.length > 0) {
        snapshot.push({ purchaseId: compra._id, itens: itensSnap });
      }
    }
  }

  // Upsert produto canônico
  await products.updateOne(
    { nome_normalizado: nomeFinalNorm },
    {
      $setOnInsert: { createdAt: new Date(), codigo: null },
      $set: { nome_original: nomeFinal, nome_normalizado: nomeFinalNorm, updatedAt: new Date() },
    },
    { upsert: true }
  );
  const produtoCanonico = await products.findOne({ nome_normalizado: nomeFinalNorm });

  // Atualizar itens nas purchases
  let totalAtualizados = 0;
  for (const descricao of descricoes) {
    const result = await purchases.updateMany(
      { 'itens.descricao': descricao },
      {
        $set: {
          'itens.$[elem].descricao':             nomeFinal,
          'itens.$[elem].descricao_normalizada': nomeFinalNorm,
          'itens.$[elem].product_id':            produtoCanonico._id,
        },
      },
      { arrayFilters: [{ 'elem.descricao': descricao }] }
    );
    totalAtualizados += result.modifiedCount;
  }

  // Deletar produtos antigos da coleção products
  const descNormsAntigas = descricoes.map(normalizeName).filter((n) => n !== nomeFinalNorm);
  await products.deleteMany({ nome_normalizado: { $in: descNormsAntigas } });

  // Salvar no merge_log
  const logEntry = await mergeLog.insertOne({
    createdAt:             new Date(),
    nome_final:            nomeFinal,
    descricoes_originais:  descricoes,
    notas_atualizadas:     totalAtualizados,
    nome_final_preexistia: nomeFinalPreexistia,
    produtos_antigos:      produtosAntigos,
    snapshot,
  });

  return res.json({
    ok: true,
    merge_id:          logEntry.insertedId,
    nome_final:        nomeFinal,
    produtos_mesclados: descricoes.length,
    notas_atualizadas: totalAtualizados,
  });
}
