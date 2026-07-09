import { normalizeProductName } from '../services/normalize.js';
import * as ProductModel from '../models/Product.js';
import * as MergeRuleModel from '../models/MergeRule.js';
import * as PurchaseModel from '../models/Purchase.js';

// ─── CONTROLLER: MesclarProdutos ─────────────────────────────────────────────
// GET  -> lista os grupos já mesclados (para a aba "Mesclagens")
// POST action=unmerge -> desfaz uma mesclagem, item a item, com precisão
// POST (default) -> mescla manualmente vários produtos em um nome final

async function listarMesclagens(req, res) {
  const regras = await MergeRuleModel.findAllSortedByUpdated();

  const grupos = new Map();
  for (const r of regras) {
    const key = r.nome_final_normalizado;
    if (!grupos.has(key)) {
      grupos.set(key, {
        nome_final: r.nome_final,
        nome_final_normalizado: key,
        atualizado_em: r.updatedAt || r.createdAt || null,
        origens: [],
        origens_origem: new Set(),
      });
    }
    const grupo = grupos.get(key);
    grupo.origens.push({
      descricao: r.descricao_original,
      mesclado_em: r.updatedAt || r.createdAt || null,
      origem: r.origem || 'desconhecida',
    });
    grupo.origens_origem.add(r.origem || 'desconhecida');
    if (r.updatedAt && (!grupo.atualizado_em || r.updatedAt > grupo.atualizado_em)) {
      grupo.atualizado_em = r.updatedAt;
    }
  }

  const gruposArray = [...grupos.values()].map((g) => {
    const origensSet = g.origens_origem;
    delete g.origens_origem;
    return { ...g, origem_do_grupo: origensSet.size === 1 ? origensSet.values().next().value : 'multiplas' };
  });

  const normas = gruposArray.map((g) => g.nome_final_normalizado);
  const produtos = await ProductModel.findManyByNormalizedNames(normas);
  const blockedMap = new Map(produtos.map((p) => [p.nome_normalizado, p.block_auto_merge === true]));

  const mesclagens = gruposArray.map((g) => ({ ...g, blocked: blockedMap.get(g.nome_final_normalizado) || false }));
  mesclagens.sort((a, b) => new Date(b.atualizado_em || 0) - new Date(a.atualizado_em || 0));

  return res.json({ ok: true, total: mesclagens.length, mesclagens });
}

// Desfaz uma mesclagem com precisão: restaura apenas os itens cujo campo
// descricao_original bate com cada origem — nunca mistura procedências.
async function desfazerMesclagem(descricaoMesclada, res) {
  let regra = await MergeRuleModel.findByFinalName(descricaoMesclada);
  if (!regra) {
    regra = await MergeRuleModel.findByFinalNormalized(normalizeProductName(descricaoMesclada));
  }
  if (!regra) {
    return res.status(404).json({ error: 'Regra de mesclagem não encontrada para esta descrição.' });
  }

  const nomeFinalNorm = regra.nome_final_normalizado;
  const todasRegras = await MergeRuleModel.findAllByFinalNormalized(nomeFinalNorm);
  if (todasRegras.length === 0) {
    return res.status(404).json({ error: 'Nenhuma regra de mesclagem encontrada para este grupo.' });
  }

  let totalRestaurados = 0;
  const originaisRecuperados = [];

  for (const r of todasRegras) {
    const descOriginal = r.descricao_original;
    const descOriginalNorm = r.descricao_original_normalizada || normalizeProductName(descOriginal);

    const prodOriginal = await ProductModel.upsertOriginalBlocked(descOriginal, descOriginalNorm);
    const updateResult = await PurchaseModel.restoreItemsByOriginalDescription(descOriginal, descOriginalNorm, prodOriginal._id);

    totalRestaurados += updateResult.modifiedCount;
    originaisRecuperados.push(descOriginal);
  }

  await ProductModel.setBlockedByNormalizedName(nomeFinalNorm, true);
  const deleteResult = await MergeRuleModel.deleteAllByFinalNormalized(nomeFinalNorm);

  return res.json({
    ok: true,
    mensagem: 'Mesclagem desfeita com sucesso.',
    itens_restaurados: totalRestaurados,
    regras_removidas: deleteResult.deletedCount,
    originais_recuperados: originaisRecuperados,
  });
}

// Mescla manualmente uma lista de descrições em um nome final único.
async function mesclarManualmente({ descricoes, nome_final }, res) {
  if (!Array.isArray(descricoes) || descricoes.length < 2) {
    return res.status(400).json({ error: 'Informe ao menos 2 produtos em "descricoes".' });
  }
  if (!nome_final || !nome_final.trim()) {
    return res.status(400).json({ error: 'Informe o "nome_final" para o produto mesclado.' });
  }

  const nomeFinal = nome_final.trim();
  const nomeFinalNorm = normalizeProductName(nomeFinal);

  const produtoCanonico = await ProductModel.upsertCanonical(nomeFinalNorm, nomeFinal);
  await ProductModel.setBlockedById(produtoCanonico._id, true);

  let totalAtualizados = 0;
  for (const descricao of descricoes) {
    await PurchaseModel.preserveOriginalDescription(descricao);
    const result = await PurchaseModel.updateItemsDescription(descricao, nomeFinal, nomeFinalNorm, produtoCanonico._id);
    totalAtualizados += result.modifiedCount;
  }

  const descNormsAntigas = descricoes.map((d) => normalizeProductName(d)).filter((n) => n !== nomeFinalNorm);
  await ProductModel.deleteManyByNormalizedNames(descNormsAntigas);

  const descricoesSemFinal = descricoes.filter((d) => normalizeProductName(d) !== nomeFinalNorm);
  for (const descOriginal of descricoesSemFinal) {
    const descOrigNorm = normalizeProductName(descOriginal);
    await MergeRuleModel.upsertRule({
      descOriginal,
      descOriginalNorm: descOrigNorm,
      nomeFinal,
      nomeFinalNorm,
      productId: produtoCanonico._id,
    });
  }

  if (descNormsAntigas.length > 0) {
    await MergeRuleModel.retargetRules(descNormsAntigas, { nomeFinal, nomeFinalNorm, productId: produtoCanonico._id });
  }

  return res.json({
    ok: true,
    nome_final: nomeFinal,
    produtos_mesclados: descricoes.length,
    notas_atualizadas: totalAtualizados,
    regras_salvas: descricoesSemFinal.length,
  });
}

export default async function mesclarProdutosController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      return await listarMesclagens(req, res);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use GET ou POST /api/mesclar-produtos' });
    }

    const { action, descricoes, nome_final, descricao_mesclada } = req.body || {};

    if (action === 'unmerge') {
      if (!descricao_mesclada) {
        return res.status(400).json({ error: 'Informe a "descricao_mesclada" para desfazer.' });
      }
      return await desfazerMesclagem(descricao_mesclada, res);
    }

    return await mesclarManualmente({ descricoes, nome_final }, res);
  } catch (err) {
    console.error('[/api/mesclar-produtos] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
