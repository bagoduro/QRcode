import { parseNotaCompleta } from '../services/parseNota.js';
import { normalizeProductName } from '../services/normalize.js';
import { upsertProduct, agruparProdutosSimilares } from '../services/fuzzyMerge.js';
import * as PurchaseModel from '../models/Purchase.js';
import * as MergeRuleModel from '../models/MergeRule.js';

// ─── CONTROLLER: ConsultaQrcode ──────────────────────────────────────────────
// Orquestra o fluxo: baixa o HTML da nota -> parseNota (service) -> aplica
// regras de mesclagem já conhecidas ou roda o fuzzyMerge (service) -> salva
// a compra (model Purchase) -> dispara a clusterização em segundo plano.

async function savePurchase(url, resultado) {
  const existing = await PurchaseModel.findByUrl(url);
  if (existing) {
    return { duplicate: true };
  }

  const rules = await MergeRuleModel.findAll();
  const rulesMap = new Map(rules.map((r) => [r.descricao_original_normalizada, r]));

  const itensEnriquecidos = await Promise.all(
    resultado.itens.map(async (item) => {
      const nomeNorm = normalizeProductName(item.descricao);
      const rule = rulesMap.get(nomeNorm);

      if (rule) {
        return {
          ...item,
          descricao_original: item.descricao,
          descricao: rule.nome_final,
          descricao_normalizada: rule.nome_final_normalizado,
          product_id: rule.product_id,
        };
      }

      const productId = await upsertProduct(item);
      return { ...item, descricao_normalizada: nomeNorm, product_id: productId };
    })
  );

  const purchase = {
    url,
    createdAt: new Date(),
    emitente: resultado.emitente,
    nota: resultado.nota,
    chave_acesso: resultado.chave_acesso,
    totais: resultado.totais,
    itens: itensEnriquecidos,
  };

  await PurchaseModel.insertPurchase(purchase);

  try {
    await agruparProdutosSimilares(resultado.itens);
  } catch (err) {
    console.error('[savePurchase] Erro na clusterização:', err.message);
  }

  return { duplicate: false };
}

export default async function consultaQrcodeController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  if (!url) return res.status(400).json({ error: 'Parâmetro "url" é obrigatório.' });

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL inválida.' });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!response.ok) return res.status(502).json({ error: 'Falha ao obter a página.' });

    const html = await response.text();
    const resultado = parseNotaCompleta(html);

    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) {
      return res.status(409).json({ error: 'Nota já registrada.', duplicate: true });
    }

    return res.json(resultado);
  } catch (err) {
    console.error('Erro:', err.message);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}
