import { getDb } from '../db.js';
import Fuse from 'fuse.js';

const DEFAULT_THRESHOLD = 0.4;
const MAX_GROUP_SIZE = 5; // limite de itens por grupo

function normalizeProductName(text = '') {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sugerirGrupoDuplicado(lista, threshold = DEFAULT_THRESHOLD) {
  if (!lista || lista.length < 2) return null;

  const restante = [...lista];
  let melhorGrupo = null;

  while (restante.length >= 2) {
    restante.sort((a, b) => (b.vezes || 0) - (a.vezes || 0));
    const ancora = restante[0];

    const fuse = new Fuse(restante, {
      keys: ['descricao'],
      includeScore: true,
      threshold,
      ignoreLocation: true,
    });

    const achados = fuse
      .search(ancora.descricao)
      .filter((r) => r.score <= threshold)
      .map((r) => r.item);

    if (achados.length >= 2 && achados.length <= MAX_GROUP_SIZE) {
      const grupo = { ancora, itens: achados };
      if (!melhorGrupo || grupo.itens.length > melhorGrupo.itens.length) {
        melhorGrupo = grupo;
      }
    }

    const descartar = new Set([ancora.descricao, ...achados.map((i) => i.descricao)]);
    for (let i = restante.length - 1; i >= 0; i--) {
      if (descartar.has(restante[i].descricao)) restante.splice(i, 1);
    }
  }

  return melhorGrupo;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.MIGRATE_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Configuração ausente: MIGRATE_SECRET não definida.' });
  }

  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST /api/migrate?secret=SUA_SENHA' });
  }

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const products = db.collection('products');
    const mergeRules = db.collection('merge_rules');

    const pipeline = [
      { $unwind: '$itens' },
      {
        $group: {
          _id: '$itens.descricao_normalizada',
          descricao: { $first: '$itens.descricao' },
          vezes: { $sum: 1 }
        }
      }
    ];

    const todosProdutos = await purchases.aggregate(pipeline).toArray();
    const listaParaFuse = todosProdutos.map(p => ({
      descricao: p.descricao,
      descricao_normalizada: p._id,
      vezes: p.vezes
    }));

    let gruposMesclados = 0;
    let totalRegrasCriadas = 0;
    let totalNotasAtualizadas = 0;

    let atual = listaParaFuse;
    while (true) {
      const grupo = sugerirGrupoDuplicado(atual, DEFAULT_THRESHOLD);
      if (!grupo) break;

      const nomeFinal = grupo.ancora.descricao;
      const nomeFinalNorm = normalizeProductName(nomeFinal);
      const descricoesOriginais = grupo.itens.map(i => i.descricao);

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

      // 🔥 BLOQUEIA O ÂNCORA
      await products.updateOne(
        { _id: produtoCanonico._id },
        { $set: { block_auto_merge: true, updatedAt: new Date() } }
      );

      for (const descOriginal of descricoesOriginais) {
        if (normalizeProductName(descOriginal) === nomeFinalNorm) continue;

        const descOrigNorm = normalizeProductName(descOriginal);

        await mergeRules.updateOne(
          { descricao_original_normalizada: descOrigNorm },
          {
            $set: {
              descricao_original: descOriginal,
              descricao_original_normalizada: descOrigNorm,
              nome_final: nomeFinal,
              nome_final_normalizado: nomeFinalNorm,
              product_id: produtoCanonico._id,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true }
        );
        totalRegrasCriadas++;

        await purchases.updateMany(
          { 'itens.descricao': descOriginal, 'itens.descricao_original': { $exists: false } },
          { $set: { 'itens.$[elem].descricao_original': descOriginal } },
          { arrayFilters: [{ 'elem.descricao': descOriginal }] }
        );

        const result = await purchases.updateMany(
          { 'itens.descricao': descOriginal },
          {
            $set: {
              'itens.$[elem].descricao': nomeFinal,
              'itens.$[elem].descricao_normalizada': nomeFinalNorm,
              'itens.$[elem].product_id': produtoCanonico._id,
            },
          },
          { arrayFilters: [{ 'elem.descricao': descOriginal }] }
        );
        totalNotasAtualizadas += result.modifiedCount;
      }

      gruposMesclados++;
      const descricoesNoGrupo = new Set(descricoesOriginais);
      atual = atual.filter(i => !descricoesNoGrupo.has(i.descricao));
    }

    return res.json({
      ok: true,
      resumo: {
        grupos_mesclados: gruposMesclados,
        regras_criadas: totalRegrasCriadas,
        notas_atualizadas: totalNotasAtualizadas
      }
    });

  } catch (err) {
    console.error('[migrate] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}