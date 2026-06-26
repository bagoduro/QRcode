import 'dotenv/config';
import { load } from 'cheerio';
import Fuse from 'fuse.js';
import { getDb } from '../db.js';

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
const FUZZY_THRESHOLD = 0.5;
const CLUSTER_THRESHOLD = 0.35; // REDUZIDO para evitar falsos positivos
const MAX_GROUP_SIZE = 6;
const PALAVRAS_GENERICAS = new Set(['kg', 'g', 'ml', 'l', 'un', 'com', 'c/', 's/', 'de', 'da', 'do', 'das', 'dos']);

// ─── UTILITÁRIOS ────────────────────────────────────────────────────────────
const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

const normalizeProductName = (text = '') => {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

// ─── EXTRAI PALAVRAS-CHAVE RELEVANTES ────────────────────────────────────────
function extrairPalavrasChave(texto) {
  const palavras = texto.toLowerCase().split(/\s+/);
  return palavras
    .filter(p => p.length >= 3) // ignora palavras muito curtas
    .filter(p => !PALAVRAS_GENERICAS.has(p)) // ignora genéricas
    .filter(p => !/^\d+$/.test(p)); // ignora números
}

// ─── VERIFICA SE DOIS PRODUTOS SÃO REALMENTE SIMILARES (PALAVRAS-CHAVE) ──────
function saoProdutosSimilares(desc1, desc2) {
  const palavras1 = extrairPalavrasChave(desc1);
  const palavras2 = extrairPalavrasChave(desc2);
  if (palavras1.length === 0 || palavras2.length === 0) return false;
  return palavras1.some(p => palavras2.includes(p));
}

// ─── FUNÇÃO DE CLUSTERIZAÇÃO COM VERIFICAÇÃO DE PALAVRAS-CHAVE ──────────────
function sugerirGrupoDuplicado(lista, threshold = CLUSTER_THRESHOLD) {
  if (!lista || lista.length < 2) return null;
  const restante = [...lista];
  let melhor = null;
  while (restante.length >= 2) {
    restante.sort((a, b) => (b.vezes || 0) - (a.vezes || 0));
    const ancora = restante[0];
    const fuse = new Fuse(restante, {
      keys: ['descricao'],
      includeScore: true,
      threshold,
      ignoreLocation: true,
    });
    const achados = fuse.search(ancora.descricao)
      .filter(r => r.score <= threshold)
      .map(r => r.item);

    const filtrados = achados.filter(item =>
      saoProdutosSimilares(ancora.descricao, item.descricao)
    );

    if (filtrados.length >= 2 && filtrados.length <= MAX_GROUP_SIZE) {
      const grupo = { ancora, itens: filtrados };
      if (!melhor || grupo.itens.length > melhor.itens.length) melhor = grupo;
    }

    const descartar = new Set([ancora.descricao, ...achados.map(i => i.descricao)]);
    for (let i = restante.length - 1; i >= 0; i--) {
      if (descartar.has(restante[i].descricao)) restante.splice(i, 1);
    }
  }
  return melhor;
}

// ─── CRIAR REGRA DE MESCLAGEM ──────────────────────────────────────────────
async function criarRegraEMesclar(db, item, ancora, descNorm) {
  const mergeRules = db.collection('merge_rules');
  const purchases = db.collection('purchases');
  const products = db.collection('products');

  const existing = await mergeRules.findOne({ descricao_original_normalizada: descNorm });
  if (existing) return;

  // 🔥 BLOQUEIA O ÂNCORA (produto final)
  await products.updateOne(
    { _id: ancora._id },
    { $set: { block_auto_merge: true, updatedAt: new Date() } }
  );

  await mergeRules.updateOne(
    { descricao_original_normalizada: descNorm },
    {
      $set: {
        descricao_original: item.descricao,
        descricao_original_normalizada: descNorm,
        nome_final: ancora.nome_original,
        nome_final_normalizado: ancora.nome_normalizado,
        product_id: ancora._id,
        updatedAt: new Date(),
        origem: 'auto',
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  await purchases.updateMany(
    { 'itens.descricao': item.descricao, 'itens.descricao_original': { $exists: false } },
    { $set: { 'itens.$[elem].descricao_original': item.descricao } },
    { arrayFilters: [{ 'elem.descricao': item.descricao }] }
  );

  await purchases.updateMany(
    { 'itens.descricao': item.descricao },
    {
      $set: {
        'itens.$[elem].descricao': ancora.nome_original,
        'itens.$[elem].descricao_normalizada': ancora.nome_normalizado,
        'itens.$[elem].product_id': ancora._id,
      },
    },
    { arrayFilters: [{ 'elem.descricao': item.descricao }] }
  );
}

// ─── MESCLAR GRUPO ──────────────────────────────────────────────────────────
async function mesclarGrupo(db, grupo) {
  const products = db.collection('products');
  const mergeRules = db.collection('merge_rules');
  const purchases = db.collection('purchases');

  const ancora = grupo.ancora;
  const itens = grupo.itens;

  // 🔥 BLOQUEIA O ÂNCORA (produto final)
  await products.updateOne(
    { _id: ancora._id },
    { $set: { block_auto_merge: true, updatedAt: new Date() } }
  );

  for (const item of itens) {
    if (item._id.toString() === ancora._id.toString()) continue;
    const descOriginal = item.descricao;
    const descNorm = normalizeProductName(descOriginal);

    const existingRule = await mergeRules.findOne({ descricao_original_normalizada: descNorm });
    if (!existingRule) {
      await mergeRules.updateOne(
        { descricao_original_normalizada: descNorm },
        {
          $set: {
            descricao_original: descOriginal,
            descricao_original_normalizada: descNorm,
            nome_final: ancora.descricao,
            nome_final_normalizado: normalizeProductName(ancora.descricao),
            product_id: ancora._id,
            updatedAt: new Date(),
            origem: 'cluster',
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );

      await purchases.updateMany(
        { 'itens.descricao': descOriginal, 'itens.descricao_original': { $exists: false } },
        { $set: { 'itens.$[elem].descricao_original': descOriginal } },
        { arrayFilters: [{ 'elem.descricao': descOriginal }] }
      );

      await purchases.updateMany(
        { 'itens.descricao': descOriginal },
        {
          $set: {
            'itens.$[elem].descricao': ancora.descricao,
            'itens.$[elem].descricao_normalizada': normalizeProductName(ancora.descricao),
            'itens.$[elem].product_id': ancora._id,
          },
        },
        { arrayFilters: [{ 'elem.descricao': descOriginal }] }
      );

      await products.updateOne(
        { _id: item._id },
        { $set: { block_auto_merge: true } }
      );

      console.log(`[cluster] Mesclado: "${descOriginal}" → "${ancora.descricao}"`);
    }
  }
}

// ─── AGRUPAR PRODUTOS SIMILARES APÓS A NOTA ────────────────────────────────
async function agruparProdutosSimilares(db, itensDaNota) {
  const products = db.collection('products');
  const purchases = db.collection('purchases');

  for (const item of itensDaNota) {
    const descNorm = normalizeProductName(item.descricao);
    const produtoAtual = await products.findOne({ nome_normalizado: descNorm });
    if (!produtoAtual) continue;

    const allProducts = await products.find({
      _id: { $ne: produtoAtual._id },
      block_auto_merge: { $ne: true }
    }).toArray();

    if (allProducts.length === 0) continue;

    const contagem = await purchases.aggregate([
      { $unwind: '$itens' },
      { $group: { _id: '$itens.product_id', vezes: { $sum: 1 } } }
    ]).toArray();
    const mapContagem = new Map(contagem.map(c => [String(c._id), c.vezes]));

    const lista = [
      {
        descricao: produtoAtual.nome_original,
        descricao_normalizada: produtoAtual.nome_normalizado,
        _id: produtoAtual._id,
        vezes: mapContagem.get(String(produtoAtual._id)) || 0
      },
      ...allProducts.map(p => ({
        descricao: p.nome_original,
        descricao_normalizada: p.nome_normalizado,
        _id: p._id,
        vezes: mapContagem.get(String(p._id)) || 0
      }))
    ];

    const grupo = sugerirGrupoDuplicado(lista, CLUSTER_THRESHOLD);
    if (grupo && grupo.itens.length >= 2) {
      console.log(`[cluster] Grupo com ${grupo.itens.length} itens. Âncora: "${grupo.ancora.descricao}"`);
      await mesclarGrupo(db, grupo);
    }
  }
}

// ─── UPSERT ──────────────────────────────────────────────────────────────────
const upsertProduct = async (db, item) => {
  const products = db.collection('products');
  const mergeRules = db.collection('merge_rules');
  const nomeNormalizado = normalizeProductName(item.descricao);

  let existing = await products.findOne({ nome_normalizado: nomeNormalizado });
  if (existing) {
    await products.updateOne({ _id: existing._id }, { $set: { updatedAt: new Date() } });
    console.log(`[upsert] ✅ Exato: "${item.descricao}" → "${existing.nome_original}"`);
    return existing._id;
  }

  const allProducts = await products.find({ block_auto_merge: { $ne: true } }).toArray();
  console.log(`[upsert] 🔍 Total de produtos disponíveis para fuzzy: ${allProducts.length}`);

  if (allProducts.length > 0) {
    const fuse = new Fuse(allProducts, {
      keys: ['nome_original', 'nome_normalizado'],
      threshold: FUZZY_THRESHOLD,
      includeScore: true,
      ignoreLocation: true,
    });

    const resultados = fuse.search(item.descricao)
      .filter(r => r.score <= FUZZY_THRESHOLD)
      .sort((a, b) => a.score - b.score);

    console.log(`[upsert] 🎯 Fuzzy: "${item.descricao}" → ${resultados.length} candidatos`);

    if (resultados.length > 0) {
      resultados.slice(0, 5).forEach((r, i) => {
        console.log(`  ${i+1}. "${r.item.nome_original}" (score: ${r.score.toFixed(4)})`);
      });

      const similar = resultados[0].item;
      console.log(`[upsert] 🏆 Melhor: "${similar.nome_original}" (score: ${resultados[0].score.toFixed(4)})`);

      await products.updateOne(
        { _id: similar._id },
        { $set: { updatedAt: new Date() } }
      );

      const descNorm = normalizeProductName(item.descricao);
      const existingRule = await mergeRules.findOne({ descricao_original_normalizada: descNorm });
      if (!existingRule) {
        await criarRegraEMesclar(db, item, similar, descNorm);
        console.log(`[upsert] 📝 Regra criada via fuzzy`);
      }
      return similar._id;
    }
  }

  const doc = {
    createdAt: new Date(),
    codigo: item.codigo || null,
    nome_original: item.descricao,
    nome_normalizado: nomeNormalizado,
    updatedAt: new Date(),
  };
  const result = await products.insertOne(doc);
  console.log(`[upsert] 🆕 Criado novo produto: "${item.descricao}"`);
  return result.insertedId;
};

// ─── SALVAR COMPRA ──────────────────────────────────────────────────────────
const savePurchase = async (url, resultado) => {
  try {
    console.log('[savePurchase] Iniciando...', { url });
    const db = await getDb();
    const purchases = db.collection('purchases');
    const mergeRules = db.collection('merge_rules');

    const existing = await purchases.findOne({ url });
    if (existing) {
      console.log('[savePurchase] Duplicata.');
      return { duplicate: true };
    }

    const rules = await mergeRules.find({}).toArray();
    const rulesMap = new Map(rules.map(r => [r.descricao_original_normalizada, r]));

    const itensEnriquecidos = await Promise.all(
      resultado.itens.map(async (item) => {
        const nomeNorm = normalizeProductName(item.descricao);
        const rule = rulesMap.get(nomeNorm);

        if (rule) {
          console.log(`[savePurchase] Regra existente: "${item.descricao}" → "${rule.nome_final}"`);
          return {
            ...item,
            descricao_original: item.descricao,
            descricao: rule.nome_final,
            descricao_normalizada: rule.nome_final_normalizado,
            product_id: rule.product_id,
          };
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
    console.log('[savePurchase] Nota salva com sucesso.');

    try {
      await agruparProdutosSimilares(db, resultado.itens);
    } catch (err) {
      console.error('[savePurchase] Erro na clusterização:', err.message);
    }

    return { duplicate: false };
  } catch (error) {
    console.error('[savePurchase] Erro:', error.message, error.stack);
    throw error;
  }
};

// ─── FUNÇÕES DE PARSING (SEM ALTERAÇÕES) ────────────────────────────────────
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

// ─── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  console.log(`[${req.method} /api/consulta-qrcode] Requisição:`, { url });

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
    console.error(`Erro:`, err.message);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}