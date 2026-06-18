import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST /api/mesclar-produtos' });
  }

  const { action, descricoes, nome_final, descricao_mesclada } = req.body || {};

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const products  = db.collection('products');

    // --- LÓGICA PARA DESFAZER MESCLAGEM ---
    if (action === 'unmerge') {
      if (!descricao_mesclada) {
        return res.status(400).json({ error: 'Informe a "descricao_mesclada" para desfazer.' });
      }

      const pipeline = [
        { $unwind: '$itens' },
        { 
          $match: { 
            'itens.descricao': descricao_mesclada,
            'itens.descricao_original': { $exists: true }
          } 
        },
        {
          $group: {
            _id: null,
            originais: { $addToSet: '$itens.descricao_original' }
          }
        }
      ];

      const resultAggregation = await purchases.aggregate(pipeline).toArray();
      if (resultAggregation.length === 0) {
        return res.status(404).json({ error: 'Nenhum item mesclado encontrado para esta descrição.' });
      }

      const descricoesOriginais = resultAggregation[0].originais;
      let totalRestaurados = 0;

      for (const descOriginal of descricoesOriginais) {
        const descNorm = descOriginal
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();

        await products.updateOne(
          { nome_normalizado: descNorm },
          {
            $setOnInsert: { createdAt: new Date(), codigo: null },
            $set: {
              nome_original: descOriginal,
              nome_normalizado: descNorm,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
        const prodOriginal = await products.findOne({ nome_normalizado: descNorm });

        const updateResult = await purchases.updateMany(
          { 
            'itens.descricao': descricao_mesclada, 
            'itens.descricao_original': descOriginal 
          },
          {
            $set: {
              'itens.$[elem].descricao': descOriginal,
              'itens.$[elem].descricao_normalizada': descNorm,
              'itens.$[elem].product_id': prodOriginal._id
            },
            $unset: {
              'itens.$[elem].descricao_original': ""
            }
          },
          { arrayFilters: [{ 'elem.descricao': descricao_mesclada, 'elem.descricao_original': descOriginal }] }
        );
        totalRestaurados += updateResult.modifiedCount;
      }

      return res.json({
        ok: true,
        mensagem: 'Mesclagem desfeita com sucesso.',
        itens_restaurados: totalRestaurados,
        originais_recuperados: descricoesOriginais
      });
    }

    // --- LÓGICA PARA MESCLAR PRODUTOS (PADRÃO) ---
    if (!Array.isArray(descricoes) || descricoes.length < 2) {
      return res.status(400).json({ error: 'Informe ao menos 2 produtos em "descricoes".' });
    }
    if (!nome_final || !nome_final.trim()) {
      return res.status(400).json({ error: 'Informe o "nome_final" para o produto mesclado.' });
    }

    const nomeFinal = nome_final.trim();
    const nomeFinalNorm = nomeFinal
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

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

    let totalAtualizados = 0;
    for (const descricao of descricoes) {
      await purchases.updateMany(
        { 'itens.descricao': descricao, 'itens.descricao_original': { $exists: false } },
        {
          $set: { 'itens.$[elem].descricao_original': descricao }
        },
        { arrayFilters: [{ 'elem.descricao': descricao }] }
      );

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
