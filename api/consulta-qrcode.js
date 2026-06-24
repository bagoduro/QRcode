import 'dotenv/config';
import { load } from 'cheerio';
import Fuse from 'fuse.js';
import { getDb } from '../db.js';
import { sugerirGrupoDuplicado } from '../lib/fuzzyMerge.js';

// ─── Constantes ──────────────────────────────────────────────────────────────
const FUZZY_THRESHOLD = 0.5; // aumentado de 0.35 para 0.5

// ─── Utilitários ─────────────────────────────────────────────────────────────
const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

const normalizeProductName = (text = '') => {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

// ─── Upsert produto (prioriza nome normalizado) ────────────────────────────
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

// ─── Criar regra de mesclagem (reutilizada) ──────────────────────────────────
async function criarRegraEMesclar(db, item, ancora, descNorm) {
  const mergeRules = db.collection('merge_rules');
  const purchases = db.collection('purchases');

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

// ─── Auto-merge usando clusterização (igual ao frontend) ────────────────────
async function autoMergeNovosItens(db, itensNovos) {
  const products = db.collection('products');
  const mergeRules = db.collection('merge_rules');
  const purchases = db.collection('purchases');

  // Pré-calcular contagem de compras para todos os produtos
  const pipeline = [
    { $unwind: '$itens' },
    { $group: { _id: '$itens.product_id', vezes: { $sum: 1 } } }
  ];
  const contagem = await purchases.aggregate(pipeline).toArray();
  const mapContagem = new Map(contagem.map(c => [c._id.toString(), c.vezes]));

  for (const item of itensNovos) {
    try {
      const descNorm = normalizeProductName(item.descricao);

      // Já existe regra?
      const existingRule = await mergeRules.findOne({ descricao_original_normalizada: descNorm });
      if (existingRule) continue;

      const produtoAtual = await products.findOne({ nome_normalizado: descNorm });
      if (!produtoAtual) continue;

      // Busca todos os produtos (exceto bloqueados e o atual)
      const allProducts = await products.find({
        _id: { $ne: produtoAtual._id },
        block_auto_merge: { $ne: true }
      }).toArray();

      if (allProducts.length === 0) continue;

      // Filtro fuzzy para encontrar candidatos similares (threshold 0.5)
      const fuse = new Fuse(allProducts, {
        keys: ['nome_original', 'nome_normalizado'],
        threshold: FUZZY_THRESHOLD,
        includeScore: true,
        ignoreLocation: true,
      });
      const candidatos = fuse.search(item.descricao)
        .filter(r => r.score <= FUZZY_THRESHOLD)
        .map(r => r.item);

      if (candidatos.length === 0) continue;

      // Monta lista para clusterização (inclui o produto atual)
      const listaParaCluster = [
        {
          descricao: produtoAtual.nome_original,
          descricao_normalizada: produtoAtual.nome_normalizado,
          _id: produtoAtual._id,
          vezes: mapContagem.get(produtoAtual._id.toString()) || 0
        },
        ...candidatos.map(p => ({
          descricao: p.nome_original,
          descricao_normalizada: p.nome_normalizado,
          _id: p._id,
          vezes: mapContagem.get(p._id.toString()) || 0
        }))
      ];

      // Executa clusterização (threshold 0.5)
      const grupo = sugerirGrupoDuplicado(listaParaCluster, 0.5);
      if (!grupo) continue;

      const itemNoGrupo = grupo.itens.some(i => i._id.toString() === produtoAtual._id.toString());
      if (!itemNoGrupo) continue;

      const ancora = grupo.ancora;
      if (ancora._id.toString() === produtoAtual._id.toString()) continue;

      // Mescla todos os itens do grupo (exceto a âncora)
      for (const itemDoGrupo of grupo.itens) {
        if (itemDoGrupo._id.toString() === ancora._id.toString()) continue;

        const descOriginal = itemDoGrupo.descricao;
        const descNormItem = normalizeProductName(descOriginal);

        await criarRegraEMesclar(db, { descricao: descOriginal }, ancora, descNormItem);

        await products.updateOne(
          { _id: itemDoGrupo._id },
          { $set: { block_auto_merge: true } }
        );
      }
    } catch (err) {
      // Log do erro mas não interrompe o fluxo
      console.error('[autoMergeNovosItens] Erro ao processar item:', item.descricao, err.message);
    }
  }
}

// ─── Salvar compra (com auto-merge pós-inserção) ──────────────────────────
const savePurchase = async (url, resultado) => {
  try {
    console.log('[savePurchase] Iniciando salvamento...', { url });
    const db = await getDb();
    const purchases = db.collection('purchases');
    const mergeRules = db.collection('merge_rules');
    const products = db.collection('products');

    const existing = await purchases.findOne({ url });
    if (existing) {
      console.log('[savePurchase] URL já registrada, ignorando duplicata.');
      return { duplicate: true };
    }

    // Guarda os itens originais para o auto-merge posterior
    const itensOriginais = resultado.itens.map(item => ({ ...item }));

    // Processa cada item: aplica regras existentes ou faz upsert
    const regras = await mergeRules.find({}).toArray();
    const mapRegras = new Map(regras.map(r => [r.descricao_original_normalizada, r]));

    // Carrega produtos existentes para fuzzy-merge (antes de upsert)
    const produtosExistentes = await products.find({ block_auto_merge: { $ne: true } }).toArray();
    const produtosPorNomeNorm = new Map(produtosExistentes.map(p => [p.nome_normalizado, p]));
    const produtosPorCodigo = new Map(
      produtosExistentes.filter(p => p.codigo).map(p => [p.codigo, p])
    );

    // Fuse para fuzzy-merge durante o upsert (threshold aumentado)
    const fuse = new Fuse(produtosExistentes, {
      keys: ['nome_original', 'nome_normalizado'],
      includeScore: true,
      threshold: FUZZY_THRESHOLD,
      ignoreLocation: true,
    });

    let fuzzyMergedCount = 0;

    const itensEnriquecidos = await Promise.all(
      resultado.itens.map(async (item) => {
        const normOriginal = normalizeProductName(item.descricao);
        const regra = mapRegras.get(normOriginal);

        if (regra) {
          console.log(`[savePurchase] Auto-merge (regra): "${item.descricao}" → "${regra.nome_final}"`);
          return {
            ...item,
            descricao_original: item.descricao,
            descricao: regra.nome_final,
            descricao_normalizada: regra.nome_final_normalizado,
            product_id: regra.product_id,
          };
        }

        // Fuzzy-merge: se não existe exato e código não é conhecido
        const codigoJaConhecido = item.codigo && produtosPorCodigo.has(item.codigo);
        if (!codigoJaConhecido && !produtosPorNomeNorm.has(normOriginal)) {
          const achados = fuse.search(item.descricao)
            .filter(r => r.score <= FUZZY_THRESHOLD)
            .sort((a, b) => a.score - b.score);

          if (achados.length > 0) {
            fuzzyMergedCount++;
            const produtoCanonico = achados[0].item;
            console.log(`[savePurchase] Fuzzy-merge: "${item.descricao}" → "${produtoCanonico.nome_original}"`);
            await mergeRules.updateOne(
              { descricao_original_normalizada: normOriginal },
              {
                $set: {
                  descricao_original: item.descricao,
                  descricao_original_normalizada: normOriginal,
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

        // Padrão: upsert
        const productId = await upsertProduct(db, item);
        return {
          ...item,
          descricao_normalizada: normOriginal,
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
    console.log('[savePurchase] Documento inserido com sucesso.');

    // ─── AUTO-MERGE POR CLUSTERIZAÇÃO (igual ao frontend) ──────────────────
    // Executa após salvar a nota, com tratamento de erro para não quebrar
    try {
      await autoMergeNovosItens(db, itensOriginais);
    } catch (err) {
      console.error('[savePurchase] Erro no auto-merge por clusterização:', err.message, err.stack);
      // Não interrompe a resposta – a nota já foi salva
    }

    return { duplicate: false, fuzzy_merged: fuzzyMergedCount };
  } catch (error) {
    console.error('[savePurchase] Erro ao salvar:', error.message, error.stack);
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

// ─── Handler Vercel ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  console.log(`[${req.method} /api/consulta-qrcode] Requisição recebida:`, { url });

  if (!url) {
    return res.status(400).json({ error: 'Parâmetro "url" é obrigatório.' });
  }

  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({ error: 'URL inválida.' });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Falha ao obter a página da SEFAZ-MG.' });
    }

    const html = await response.text();
    const resultado = parseHtml(html);

    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) {
      return res.status(409).json({ error: 'Nota já registrada anteriormente.', duplicate: true });
    }

    return res.json({
      ...resultado,
      fuzzy_merged: saveResult?.fuzzy_merged ?? 0,
    });
  } catch (err) {
    console.error(`[${req.method} /api/consulta-qrcode] Erro:`, err.message);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}