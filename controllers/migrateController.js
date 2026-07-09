import * as PurchaseModel from '../models/Purchase.js';
import * as ProductModel from '../models/Product.js';
import * as MergeRuleModel from '../models/MergeRule.js';
import { normalizeProductName } from '../services/normalize.js';
import { sugerirGrupoDuplicado } from '../services/fuzzyMerge.js';

// ─── CONTROLLER: Migrate ─────────────────────────────────────────────────────
// Ferramenta de manutenção: reprocessa TODO o catálogo histórico, agrupando
// duplicatas com o mesmo algoritmo fuzzy usado na clusterização pós-compra
// (mas sem o filtro de palavras-chave, igual ao comportamento original).

export default async function migrateController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.MIGRATE_SECRET;
  if (!secret) return res.status(500).json({ error: 'Configuração ausente: MIGRATE_SECRET não definida.' });
  if (req.query.secret !== secret) return res.status(401).json({ error: 'Senha incorreta.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST /api/migrate?secret=SUA_SENHA' });

  try {
    const todosProdutos = await PurchaseModel.aggregate([
      { $unwind: '$itens' },
      { $group: { _id: '$itens.descricao_normalizada', descricao: { $first: '$itens.descricao' }, vezes: { $sum: 1 } } },
    ]);

    let listaParaFuse = todosProdutos.map((p) => ({ descricao: p.descricao, descricao_normalizada: p._id, vezes: p.vezes }));

    let gruposMesclados = 0;
    let totalRegrasCriadas = 0;
    let totalNotasAtualizadas = 0;

    while (true) {
      const grupo = sugerirGrupoDuplicado(listaParaFuse, 0.4, false);
      if (!grupo) break;

      const nomeFinal = grupo.ancora.descricao;
      const nomeFinalNorm = normalizeProductName(nomeFinal);
      const descricoesOriginais = grupo.itens.map((i) => i.descricao);

      const produtoCanonico = await ProductModel.upsertCanonical(nomeFinalNorm, nomeFinal);
      await ProductModel.setBlockedById(produtoCanonico._id, true);

      for (const descOriginal of descricoesOriginais) {
        if (normalizeProductName(descOriginal) === nomeFinalNorm) continue;
        const descOrigNorm = normalizeProductName(descOriginal);

        await MergeRuleModel.upsertRule({
          descOriginal,
          descOriginalNorm: descOrigNorm,
          nomeFinal,
          nomeFinalNorm,
          productId: produtoCanonico._id,
        });
        totalRegrasCriadas++;

        await PurchaseModel.preserveOriginalDescription(descOriginal);
        const result = await PurchaseModel.updateItemsDescription(descOriginal, nomeFinal, nomeFinalNorm, produtoCanonico._id);
        totalNotasAtualizadas += result.modifiedCount;
      }

      gruposMesclados++;
      const descricoesNoGrupo = new Set(descricoesOriginais);
      listaParaFuse = listaParaFuse.filter((i) => !descricoesNoGrupo.has(i.descricao));
    }

    return res.json({
      ok: true,
      resumo: { grupos_mesclados: gruposMesclados, regras_criadas: totalRegrasCriadas, notas_atualizadas: totalNotasAtualizadas },
    });
  } catch (err) {
    console.error('[migrate] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
