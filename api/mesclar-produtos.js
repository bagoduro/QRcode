import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ─── GET /api/mesclar-produtos ────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const db = await getDb();
      const mergeRules = db.collection('merge_rules');
      const regras = await mergeRules.find({}).sort({ updatedAt: -1 }).toArray();

      const grupos = new Map();
      for (const r of regras) {
        const key = r.nome_final_normalizado;
        if (!grupos.has(key)) {
          grupos.set(key, {
            nome_final: r.nome_final,
            nome_final_normalizado: key,
            atualizado_em: r.updatedAt || r.createdAt || null,
            origens: [],
          });
        }
        const grupo = grupos.get(key);
        grupo.origens.push({
          descricao: r.descricao_original,
          mesclado_em: r.updatedAt || r.createdAt || null,
        });
        if (r.updatedAt && (!grupo.atualizado_em || r.updatedAt > grupo.atualizado_em)) {
          grupo.atualizado_em = r.updatedAt;
        }
      }

      const gruposArray = [...grupos.values()];
      const normas = gruposArray.map(g => g.nome_final_normalizado);
      const produtos = await db.collection('products').find({ nome_normalizado: { $in: normas } }).toArray();
      const blockedMap = new Map(produtos.map(p => [p.nome_normalizado, p.block_auto_merge === true]));

      const mesclagens = gruposArray.map(g => ({
        ...g,
        blocked: blockedMap.get(g.nome_final_normalizado) || false,
      }));

      mesclagens.sort((a, b) => new Date(b.atualizado_em || 0) - new Date(a.atualizado_em || 0));

      return res.json({ ok: true, total: mesclagens.length, mesclagens });
    } catch (err) {
      console.error('[GET /api/mesclar-produtos] Erro:', err.message, err.stack);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use GET ou POST /api/mesclar-produtos' });
  }

  const { action, descricoes, nome_final, descricao_mesclada } = req.body || {};

  try {
    const db = await getDb();
    const purchases    = db.collection('purchases');
    const products     = db.collection('products');
    const mergeRules   = db.collection('merge_rules');

    const norm = (text = '') =>
      text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

    // ─── DESFAZER MESCLAGEM ──────────────────────────────────────────────────
    if (action === 'unmerge') {
      if (!descricao_mesclada) {
        return res.status(400).json({ error: 'Informe a "descricao_mesclada" para desfazer.' });
      }

      let regra = await mergeRules.findOne({ nome_final: descricao_mesclada });
      if (!regra) {
        const descNorm = norm(descricao_mesclada);
        regra = await mergeRules.findOne({ nome_final_normalizado: descNorm });
      }
      if (!regra) {
        return res.status(404).json({ error: 'Regra de mesclagem não encontrada para esta descrição.' });
      }

      const nomeFinalNorm = regra.nome_final_normalizado;

      const todasRegras = await mergeRules.find({ nome_final_normalizado: nomeFinalNorm }).toArray();
      if (todasRegras.length === 0) {
        return res.status(404).json({ error: 'Nenhuma regra de mesclagem encontrada para este grupo.' });
      }

      let totalRestaurados = 0;
      const originaisRecuperados = [];

      for (const r of todasRegras) {
        const descOriginal = r.descricao_original;
        const descOriginalNorm = r.descricao_original_normalizada || norm(descOriginal);

        // BLOQUEIA ao desfazer
        await products.updateOne(
          { nome_normalizado: descOriginalNorm },
          {
            $setOnInsert: { createdAt: new Date(), codigo: null },
            $set: {
              nome_original: descOriginal,
              nome_normalizado: descOriginalNorm,
              updatedAt: new Date(),
              block_auto_merge: true
            },
          },
          { upsert: true }
        );
        const prodOriginal = await products.findOne({ nome_normalizado: descOriginalNorm });

        const updateResult = await purchases.updateMany(
          {
            'itens.descricao_original': descOriginal,
            'itens.descricao': regra.nome_final
          },
          {
            $set: {
              'itens.$[elem].descricao': descOriginal,
              'itens.$[elem].descricao_normalizada': descOriginalNorm,
              'itens.$[elem].product_id': prodOriginal._id
            },
            $unset: {
              'itens.$[elem].descricao_original': ""
            }
          },
          { arrayFilters: [{ 'elem.descricao_original': descOriginal }] }
        );
        totalRestaurados += updateResult.modifiedCount;
        originaisRecuperados.push(descOriginal);
      }

      await mergeRules.deleteMany({ nome_final_normalizado: nomeFinalNorm });

      return res.json({
        ok: true,
        mensagem: 'Mesclagem desfeita com sucesso.',
        itens_restaurados: totalRestaurados,
        originais_recuperados: originaisRecuperados
      });
    }

    // ─── MESCLAR PRODUTOS ────────────────────────────────────────────────────
    if (!Array.isArray(descricoes) || descricoes.length < 2) {
      return res.status(400).json({ error: 'Informe ao menos 2 produtos em "descricoes".' });
    }
    if (!nome_final || !nome_final.trim()) {
      return res.status(400).json({ error: 'Informe o "nome_final" para o produto mesclado.' });
    }

    const nomeFinal     = nome_final.trim();
    const nomeFinalNorm = norm(nomeFinal);

    // 🔥 MUDANÇA: mesclagem manual também BLOQUEIA o produto final
    await products.updateOne(
      { nome_normalizado: nomeFinalNorm },
      {
        $setOnInsert: { createdAt: new Date(), codigo: null },
        $set: {
          nome_original: nomeFinal,
          nome_normalizado: nomeFinalNorm,
          updatedAt: new Date(),
          block_auto_merge: true   // <-- agora bloqueia
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
      .map((d) => norm(d))
      .filter((n) => n !== nomeFinalNorm);

    await products.deleteMany({
      nome_normalizado: { $in: descNormsAntigas },
    });

    const descricoesSemFinal = descricoes.filter((d) => norm(d) !== nomeFinalNorm);
    for (const descOriginal of descricoesSemFinal) {
      const descOrigNorm = norm(descOriginal);
      await mergeRules.updateOne(
        { descricao_original_normalizada: descOrigNorm },
        {
          $set: {
            descricao_original:           descOriginal,
            descricao_original_normalizada: descOrigNorm,
            nome_final:                   nomeFinal,
            nome_final_normalizado:       nomeFinalNorm,
            product_id:                   produtoCanonico._id,
            updatedAt:                    new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    }

    // 🔥 CASCATA: se algum dos nomes mesclados agora (ex: "C") já era o
    // nome_final de mesclagens anteriores (ex: A→C, B→C), essas regras
    // antigas precisam ser redirecionadas para o novo nome final ("E"),
    // senão continuam apontando para um nome/produto que acabou de ser
    // absorvido (e cujo produto canônico foi deletado acima). Sem isso,
    // notas futuras com descrição "A" ou "B" voltam a cair em "C" em vez
    // de se juntar ao grupo "E".
    if (descNormsAntigas.length > 0) {
      await mergeRules.updateMany(
        { nome_final_normalizado: { $in: descNormsAntigas } },
        {
          $set: {
            nome_final:             nomeFinal,
            nome_final_normalizado: nomeFinalNorm,
            product_id:             produtoCanonico._id,
            updatedAt:              new Date(),
          },
        }
      );
    }

    return res.json({
      ok: true,
      nome_final: nomeFinal,
      produtos_mesclados: descricoes.length,
      notas_atualizadas: totalAtualizados,
      regras_salvas: descricoesSemFinal.length,
    });

  } catch (err) {
    console.error('[POST /api/mesclar-produtos] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}