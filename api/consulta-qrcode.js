import 'dotenv/config';
import { load } from 'cheerio';
import Fuse from 'fuse.js';
import { getDb } from '../db.js';

const FUZZY_THRESHOLD = 0.5; // aumentado

const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

const normalizeProductName = (text = '') => {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

const upsertProduct = async (db, item) => {
  const products = db.collection('products');
  const nomeNormalizado = normalizeProductName(item.descricao);

  let existing = await products.findOne({ nome_normalizado: nomeNormalizado });
  if (existing) {
    await products.updateOne({ _id: existing._id }, { $set: { updatedAt: new Date() } });
    return existing._id;
  }

  const doc = {
    createdAt: new Date(),
    codigo: item.codigo || null,
    nome_original: item.descricao,
    nome_normalizado: nomeNormalizado,
    updatedAt: new Date(),
  };
  const result = await products.insertOne(doc);
  return result.insertedId;
};

const savePurchase = async (url, resultado) => {
  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const mergeRules = db.collection('merge_rules');
    const products = db.collection('products');

    const existing = await purchases.findOne({ url });
    if (existing) return { duplicate: true };

    const rules = await mergeRules.find({}).toArray();
    const rulesMap = new Map(rules.map(r => [r.descricao_original_normalizada, r]));

    const produtosExistentes = await products.find({ block_auto_merge: { $ne: true } }).toArray();
    const produtosPorNomeNorm = new Map(produtosExistentes.map(p => [p.nome_normalizado, p]));

    const fuse = new Fuse(produtosExistentes, {
      keys: ['nome_original', 'nome_normalizado'], // ← agora busca em ambos
      threshold: FUZZY_THRESHOLD,
      includeScore: true,
      ignoreLocation: true,
    });

    let fuzzyMergedCount = 0;

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

        // Fuzzy-merge
        if (!produtosPorNomeNorm.has(nomeNorm)) {
          const achados = fuse.search(item.descricao)
            .filter(r => r.score <= FUZZY_THRESHOLD)
            .sort((a, b) => a.score - b.score);

          if (achados.length > 0) {
            fuzzyMergedCount++;
            const produtoCanonico = achados[0].item;
            await mergeRules.updateOne(
              { descricao_original_normalizada: nomeNorm },
              {
                $set: {
                  descricao_original: item.descricao,
                  descricao_original_normalizada: nomeNorm,
                  nome_final: produtoCanonico.nome_original,
                  nome_final_normalizado: produtoCanonico.nome_normalizado,
                  product_id: produtoCanonico._id,
                  updatedAt: new Date(),
                },
                $setOnInsert: { createdAt: new Date() },
              },
              { upsert: true }
            );
            return {
              ...item,
              descricao_original: item.descricao,
              descricao: produtoCanonico.nome_original,
              descricao_normalizada: produtoCanonico.nome_normalizado,
              product_id: produtoCanonico._id,
            };
          }
        }

        const productId = await upsertProduct(db, item);
        return {
          ...item,
          descricao_normalizada: nomeNorm,
          product_id: productId,
        };
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

    await purchases.insertOne(purchase);
    return { duplicate: false, fuzzy_merged: fuzzyMergedCount };
  } catch (error) {
    console.error('[savePurchase] Erro:', error.message, error.stack);
    throw error;
  }
};

// ─── Funções de parsing (mantidas iguais) ──────────────────────────────────
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
  const qt = parseValorNum(String(quantidade).replace(',', '.'));
  if (!vt || !qt || qt === 0) return null;
  return Math.round((vt / qt) * 100) / 100;
}

const extractTableRow = ($table, $) => {
  const row = $table.find('tbody tr').first();
  return row.find('td').toArray().map((td) => normalizeText($(td).text()));
};

const parseHtml = (html) => {
  const $ = load(html);

  const emitenteSection = $("h5:contains('Emitente')").first();
  const emitenteTable = emitenteSection.nextAll('table').first();
  const emitenteCells = extractTableRow(emitenteTable, $);

  const dataEmissaoTable = $("th:contains('Data Emissão')").closest('table');
  const dataEmissaoCells = extractTableRow(dataEmissaoTable, $);

  const valorTotalServicoTable = $("th:contains('Valor total do serviço')").closest('table');
  const valorTotalServicoCells = extractTableRow(valorTotalServicoTable, $);

  const protocoloTable = $("th:contains('Protocolo')").closest('table');
  const protocoloCells = extractTableRow(protocoloTable, $);

  const chaveAcessoPanel = $(".panel-title:contains('Chave de acesso')")
    .closest('.panel')
    .find('div.collapse tbody tr td')
    .first();
  const chaveAcesso = normalizeText(chaveAcessoPanel.text());

  const totals = {};
  $('div.row').each((_, element) => {
    const strongs = $(element)
      .find('strong')
      .toArray()
      .map((el) => normalizeText($(el).text()));
    if (strongs.length === 2 && strongs[0] !== strongs[1]) {
      totals[strongs[0]] = strongs[1];
    }
  });

  const itens = [];
  $('#myTable tr').each((_, row) => {
    const cols = $(row)
      .find('td')
      .toArray()
      .map((td) => normalizeText($(td).text()));
    if (cols.length >= 4) {
      const itemMatch = cols[0].match(/^(.*?)\s*\(Código:\s*([^\)]+)\)/i);
      itens.push({
        descricao: itemMatch ? normalizeText(itemMatch[1]) : cols[0],
        codigo: itemMatch ? normalizeText(itemMatch[2]) : null,
        quantidade: cols[1].replace(/.*?:\s*/, ''),
        unidade: cols[2].replace(/.*?:\s*/, ''),
        valor_total: cols[3].replace(/.*?:\s*/, ''),
        preco_unitario: calcPrecoUnitario(cols[3].replace(/.*?:\s*/, ''), cols[1].replace(/.*?:\s*/, '')),
      });
    }
  });

  return {
    emitente: {
      nome: emitenteCells[0] || null,
      cnpj: emitenteCells[1] || null,
      inscricao_estadual: emitenteCells[2] || null,
      uf: emitenteCells[3] || null,
    },
    nota: {
      modelo: dataEmissaoCells[0] || null,
      serie: dataEmissaoCells[1] || null,
      numero: dataEmissaoCells[2] || null,
      data_emissao: dataEmissaoCells[3] || null,
      valor_total_servico: valorTotalServicoCells[0] || null,
      protocolo: protocoloCells[0] || null,
    },
    chave_acesso: chaveAcesso || null,
    totais: {
      quantidade_total_itens: totals['Qtde total de ítens'] || null,
      valor_total: totals['Valor total R$'] || null,
      valor_pago: totals['Valor pago R$'] || null,
      forma_pagamento: totals['Forma de Pagamento'] || null,
    },
    itens,
  };
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    const resultado = parseHtml(html);
    const saveResult = await savePurchase(url, resultado);

    if (saveResult?.duplicate) {
      return res.status(409).json({ error: 'Nota já registrada.', duplicate: true });
    }

    return res.json(resultado);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}