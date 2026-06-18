import { getDb } from '../db.js';

function parseValorNum(valor) {
  if (!valor) return null;
  const limpo = String(valor)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3},)/g, '')
    .replace(',', '.');
  const n = parseFloat(limpo);
  return isNaN(n) ? null : n;
}

function calcPrecoUnitario(valor_total, quantidade) {
  const vt = parseValorNum(valor_total);
  const qt = parseValorNum(String(quantidade ?? '').replace(',', '.'));
  if (!vt || !qt || qt === 0) return null;
  return Math.round((vt / qt) * 100) / 100;
}

function normalizeProductName(text = '') {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Proteção por senha — defina MIGRATE_SECRET nas env vars da Vercel
  const secret = process.env.MIGRATE_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(401).json({ error: 'Não autorizado. Informe ?secret=SUA_SENHA' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST /api/migrate?secret=SUA_SENHA' });
  }

  try {
    const db = await getDb();
    const purchases  = db.collection('purchases');
    const products   = db.collection('products');
    const mergeRules = db.collection('merge_rules');

    // Garante índice único na coleção de regras de auto-merge
    await mergeRules.createIndex(
      { descricao_original_normalizada: 1 },
      { unique: true, name: 'idx_merge_rules_orig_norm' }
    );
    await mergeRules.createIndex(
      { nome_final_normalizado: 1 },
      { name: 'idx_merge_rules_final_norm' }
    );

    const todasCompras = await purchases.find({}).toArray();

    let notasProcessadas   = 0;
    let itensProcessados   = 0;
    let produtosCriados    = 0;
    let produtosExistentes = 0;

    for (const compra of todasCompras) {
      notasProcessadas++;
      const itensEnriquecidos = [];

      for (const item of compra.itens ?? []) {
        itensProcessados++;

        const preco_unitario =
          item.preco_unitario ?? calcPrecoUnitario(item.valor_total, item.quantidade);

        const nomeNormalizado = normalizeProductName(item.descricao);
        const filter = item.codigo
          ? { codigo: item.codigo }
          : { nome_normalizado: nomeNormalizado };

        const update = {
          $setOnInsert: {
            createdAt:        new Date(),
            codigo:           item.codigo || null,
            nome_original:    item.descricao,
            nome_normalizado: nomeNormalizado,
          },
          $set: { updatedAt: new Date() },
        };

        const existingBefore = await products.findOne(filter);
        await products.updateOne(filter, update, { upsert: true });
        const result = await products.findOne(filter);

        if (existingBefore) produtosExistentes++;
        else produtosCriados++;

        itensEnriquecidos.push({
          ...item,
          descricao_normalizada: nomeNormalizado,
          product_id:            result._id,
          preco_unitario,
        });
      }

      await purchases.updateOne(
        { _id: compra._id },
        { $set: { itens: itensEnriquecidos } }
      );
    }

    return res.json({
      ok: true,
      resumo: {
        notas_processadas:    notasProcessadas,
        itens_processados:    itensProcessados,
        produtos_criados:     produtosCriados,
        produtos_ja_existentes: produtosExistentes,
      },
    });

  } catch (err) {
    console.error('[migrate] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
