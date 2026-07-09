import Fuse from 'fuse.js';
import { normalizeProductName } from './normalize.js';
import * as ProductModel from '../models/Product.js';
import * as MergeRuleModel from '../models/MergeRule.js';
import * as PurchaseModel from '../models/Purchase.js';

// ─── SERVICE: FuzzyMerge ─────────────────────────────────────────────────────
// Concentra toda a regra de negócio de mesclagem automática de produtos:
//   1) upsertProduct       — match exato -> fuzzy (Fuse.js) -> cria produto novo
//   2) agruparProdutosSimilares — clusterização pós-compra (2ª camada)
// Ambas usam os Models (Product, MergeRule, Purchase) para persistência e
// nunca tocam o driver do MongoDB diretamente.

const FUZZY_THRESHOLD = 0.5;
const CLUSTER_THRESHOLD = 0.35;
const MAX_GROUP_SIZE = 6;
const PALAVRAS_GENERICAS = new Set(['kg', 'g', 'ml', 'l', 'un', 'com', 'c/', 's/', 'de', 'da', 'do', 'das', 'dos']);

function extrairPalavrasChave(texto) {
  return texto
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length >= 3)
    .filter((p) => !PALAVRAS_GENERICAS.has(p))
    .filter((p) => !/^\d+$/.test(p));
}

// Filtro anti-falso-positivo: só considera duas descrições duplicadas se
// compartilharem ao menos uma palavra-chave relevante.
function saoProdutosSimilares(desc1, desc2) {
  const palavras1 = extrairPalavrasChave(desc1);
  const palavras2 = extrairPalavrasChave(desc2);
  if (palavras1.length === 0 || palavras2.length === 0) return false;
  return palavras1.some((p) => palavras2.includes(p));
}

// Agrupa por similaridade usando o mais comprado como âncora, iterativamente.
export function sugerirGrupoDuplicado(lista, threshold = CLUSTER_THRESHOLD, aplicarFiltroPalavraChave = true) {
  if (!lista || lista.length < 2) return null;
  const restante = [...lista];
  let melhor = null;

  while (restante.length >= 2) {
    restante.sort((a, b) => (b.vezes || 0) - (a.vezes || 0));
    const ancora = restante[0];

    const fuse = new Fuse(restante, { keys: ['descricao'], includeScore: true, threshold, ignoreLocation: true });
    const achados = fuse
      .search(ancora.descricao)
      .filter((r) => r.score <= threshold)
      .map((r) => r.item);

    const filtrados = aplicarFiltroPalavraChave
      ? achados.filter((item) => saoProdutosSimilares(ancora.descricao, item.descricao))
      : achados;

    if (filtrados.length >= 2 && filtrados.length <= MAX_GROUP_SIZE) {
      const grupo = { ancora, itens: filtrados };
      if (!melhor || grupo.itens.length > melhor.itens.length) melhor = grupo;
    }

    const descartar = new Set([ancora.descricao, ...achados.map((i) => i.descricao)]);
    for (let i = restante.length - 1; i >= 0; i--) {
      if (descartar.has(restante[i].descricao)) restante.splice(i, 1);
    }
  }
  return melhor;
}

async function criarRegraEMesclar(item, ancora, descNorm) {
  const existing = await MergeRuleModel.findByOriginalNormalized(descNorm);
  if (existing) return;

  await ProductModel.setBlockedById(ancora._id, true);

  await MergeRuleModel.upsertRule({
    descOriginal: item.descricao,
    descOriginalNorm: descNorm,
    nomeFinal: ancora.nome_original,
    nomeFinalNorm: ancora.nome_normalizado,
    productId: ancora._id,
    origem: 'auto',
  });

  await PurchaseModel.preserveOriginalDescription(item.descricao);
  await PurchaseModel.updateItemsDescription(item.descricao, ancora.nome_original, ancora.nome_normalizado, ancora._id);
}

async function mesclarGrupo(grupo) {
  const ancora = grupo.ancora;
  await ProductModel.setBlockedById(ancora._id, true);

  for (const item of grupo.itens) {
    if (item._id.toString() === ancora._id.toString()) continue;
    const descOriginal = item.descricao;
    const descNorm = normalizeProductName(descOriginal);

    const existingRule = await MergeRuleModel.findByOriginalNormalized(descNorm);
    if (existingRule) continue;

    await MergeRuleModel.upsertRule({
      descOriginal,
      descOriginalNorm: descNorm,
      nomeFinal: ancora.descricao,
      nomeFinalNorm: normalizeProductName(ancora.descricao),
      productId: ancora._id,
      origem: 'cluster',
    });

    await PurchaseModel.preserveOriginalDescription(descOriginal);
    await PurchaseModel.updateItemsDescription(descOriginal, ancora.descricao, normalizeProductName(ancora.descricao), ancora._id);
    await ProductModel.setBlockedById(item._id, true);
  }
}

// Clusterização pós-compra: varre o catálogo em busca de duplicatas do item
// recém-salvo que ainda não foram unificadas.
export async function agruparProdutosSimilares(itensDaNota) {
  for (const item of itensDaNota) {
    const descNorm = normalizeProductName(item.descricao);
    const produtoAtual = await ProductModel.findByNormalizedName(descNorm);
    if (!produtoAtual) continue;

    const allProducts = await ProductModel.findAllUnblockedExcluding(produtoAtual._id);
    if (allProducts.length === 0) continue;

    const contagem = await PurchaseModel.aggregate([
      { $unwind: '$itens' },
      { $group: { _id: '$itens.product_id', vezes: { $sum: 1 } } },
    ]);
    const mapContagem = new Map(contagem.map((c) => [String(c._id), c.vezes]));

    const lista = [produtoAtual, ...allProducts].map((p) => ({
      descricao: p.nome_original,
      descricao_normalizada: p.nome_normalizado,
      _id: p._id,
      vezes: mapContagem.get(String(p._id)) || 0,
    }));

    const grupo = sugerirGrupoDuplicado(lista, CLUSTER_THRESHOLD, true);
    if (grupo && grupo.itens.length >= 2) {
      await mesclarGrupo(grupo);
    }
  }
}

// Match exato -> fuzzy (Fuse.js) -> cria produto novo. É a "mesclagem
// automática" que roda no momento em que cada item de uma nota é salvo.
export async function upsertProduct(item) {
  const nomeNormalizado = normalizeProductName(item.descricao);

  const existing = await ProductModel.findByNormalizedName(nomeNormalizado);
  if (existing) {
    await ProductModel.touchUpdatedAt(existing._id);
    return existing._id;
  }

  const candidatos = await ProductModel.findUnblocked();
  if (candidatos.length > 0) {
    const fuse = new Fuse(candidatos, {
      keys: ['nome_original', 'nome_normalizado'],
      threshold: FUZZY_THRESHOLD,
      includeScore: true,
      ignoreLocation: true,
    });

    const resultados = fuse.search(item.descricao).filter((r) => r.score <= FUZZY_THRESHOLD).sort((a, b) => a.score - b.score);

    if (resultados.length > 0) {
      const similar = resultados[0].item;
      await ProductModel.touchUpdatedAt(similar._id);

      const existingRule = await MergeRuleModel.findByOriginalNormalized(nomeNormalizado);
      if (!existingRule) {
        await criarRegraEMesclar(item, similar, nomeNormalizado);
      }
      return similar._id;
    }
  }

  return ProductModel.insertNew(item, nomeNormalizado);
}
