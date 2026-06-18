import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST /api/mesclar-produtos' });
  }

  const { descricoes, nome_final } = req.body || {};

  if (!Array.isArray(descricoes) || descricoes.length < 2) {
    return res.status(400).json({ error: 'Informe ao menos 2 produtos em "descricoes".' });
  }
  if (!nome_final || !nome_final.trim()) {
    return res.status(400).json({ error: 'Informe o "nome_final" para o produto mesclado.' });
  }

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const products  = db.collection('products');

    const nomeFinal = nome_final.trim();
    const nomeFinalNorm = nomeFinal
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    // Upsert produto canônico na coleção products
    await products.updateOne(
      { nome_normalizado: nomeFinalNorm },
      {
        $setOnInsert: { createdAt: new Date(), codigo: null },
        $set: {
          nome_original: nomeFinal,
          nome_normalizado: nomeFinalNorm,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    const produtoCanonico = await products.findOne({ nome_normalizado: nomeFinalNorm });

    // Atualizar todos os itens nas purchases que tenham qualquer uma das descricoes
    let totalAtualizados = 0;
    for (const descricao of descricoes) {
      const result = await purchases.updateMany(
        { 'itens.descricao': descricao },
        {
          $set: {
            'itens.$[elem].descricao':            nomeFinal,
            'itens.$[elem].descricao_normalizada': nomeFinalNorm,
            'itens.$[elem].product_id':           produtoCanonico._id,
          },
        },
        { arrayFilters: [{ 'elem.descricao': descricao }] }
      );
      totalAtualizados += result.modifiedCount;
    }

    // Remover produtos antigos da coleção products (exceto o canônico)
    const descNormsAntigas = descricoes
      .map((d) =>
        d.normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter((n) => n !== nomeFinalNorm);

    await products.deleteMany({
      nome_normalizado: { $in: descNormsAntigas },
    });

    return res.json({
      ok: true,
      nome_final: nomeFinal,
      produtos_mesclados: descricoes.length,
      notas_atualizadas: totalAtualizados,
    });
  } catch (err) {
    console.error('[POST /api/mesclar-produtos] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
