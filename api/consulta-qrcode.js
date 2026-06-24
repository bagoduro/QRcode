import 'dotenv/config';
import { load } from 'cheerio';
import Fuse from 'fuse.js';
import { getDb } from '../db.js';

const FUZZY_THRESHOLD = 0.35; // mesmo valor usado em BuscarTab/migrate.js

const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

// Normaliza nome de produto: remove acentos, lowercase, colapsa espaços
const normalizeProductName = (text = '') => {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

// Salva/atualiza produto na coleção products e retorna o productId
const upsertProduct = async (db, item) => {
  const products = db.collection('products');
  const nomeNormalizado = normalizeProductName(item.descricao);
  const filter = item.codigo
    ? { codigo: item.codigo }
    : { nome_normalizado: nomeNormalizado };

  const update = {
    $setOnInsert: {
      createdAt: new Date(),
      codigo: item.codigo || null,
      nome_original: item.descricao,
      nome_normalizado: nomeNormalizado,
    },
    $set: {
      updatedAt: new Date(),
    },
  };

  const result = await products.findOneAndUpdate(filter, update, {
    upsert: true,
    returnDocument: 'after',
  });

  return result._id;
};


const savePurchase = async (url, resultado) => {
  try {
    console.log('[savePurchase] Iniciando salvamento...', { url });
    const db = await getDb();
    console.log('[savePurchase] Conectado ao banco');
    const purchases   = db.collection('purchases');
    const mergeRules  = db.collection('merge_rules');
    const products    = db.collection('products');

    const existing = await purchases.findOne({ url });
    if (existing) {
      console.log('[savePurchase] URL já registrada, ignorando duplicata.');
      return { duplicate: true };
    }

    // Carrega todas as regras de mesclagem em memória (coleção pequena)
    const rules = await mergeRules.find({}).toArray();
    // Monta mapa: descricao_original_normalizada → regra
    const rulesMap = new Map(rules.map((r) => [r.descricao_original_normalizada, r]));

    // ── FUZZY MATCH (Fuse.js) ────────────────────────────────────────────────
    // Carrega produtos existentes (exceto bloqueados) para tentar casar, por
    // similaridade, descrições NUNCA vistas antes com um produto já existente
    // (ex: "ARROZ TIO JOAO 5KG" vs "ARROZ TIPO 1 TIO JOAO 5000G"). Isso evita
    // que cada variação de escrita crie um produto novo, sem precisar de
    // mesclagem manual.
    const produtosExistentes = await products
      .find({ block_auto_merge: { $ne: true } })
      .toArray();

    const produtosPorNomeNorm = new Map(produtosExistentes.map((p) => [p.nome_normalizado, p]));
    const produtosPorCodigo   = new Map(
      produtosExistentes.filter((p) => p.codigo).map((p) => [p.codigo, p])
    );

    const fuse = new Fuse(produtosExistentes, {
      keys: ['nome_normalizado'],
      includeScore: true,
      threshold: FUZZY_THRESHOLD,
      ignoreLocation: true,
    });

    // Cria (ou reaproveita) a regra de mesclagem e devolve os dados já
    // enriquecidos do item, apontando para o produto canônico encontrado.
    const aplicarFuzzyMerge = async (item, nomeNorm, produtoCanonico) => {
      console.log(
        `[savePurchase] Fuzzy-merge: "${item.descricao}" → "${produtoCanonico.nome_original}"`
      );
      await mergeRules.updateOne(
        { descricao_original_normalizada: nomeNorm },
        {
          $set: {
            descricao_original:             item.descricao,
            descricao_original_normalizada: nomeNorm,
            nome_final:                     produtoCanonico.nome_original,
            nome_final_normalizado:         produtoCanonico.nome_normalizado,
            product_id:                     produtoCanonico._id,
            origem:                         'fuzzy',
            updatedAt:                      new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );

      return {
        ...item,
        descricao_original:    item.descricao,
        descricao:              produtoCanonico.nome_original,
        descricao_normalizada:  produtoCanonico.nome_normalizado,
        product_id:             produtoCanonico._id,
      };
    };

    let fuzzyMergedCount = 0;

    const itensEnriquecidos = await Promise.all(
      resultado.itens.map(async (item) => {
        const nomeNorm = normalizeProductName(item.descricao);
        const rule     = rulesMap.get(nomeNorm);

        if (rule) {
          // ── AUTO-MERGE: produto conhecido com regra de mesclagem ──────────
          console.log(`[savePurchase] Auto-merge: "${item.descricao}" → "${rule.nome_final}"`);
          return {
            ...item,
            descricao_original:       item.descricao,        // preserva o original
            descricao:                rule.nome_final,        // aplica o nome mesclado
            descricao_normalizada:    rule.nome_final_normalizado,
            product_id:               rule.product_id,
          };
          // ─────────────────────────────────────────────────────────────────
        }

        // ── FUZZY-MERGE: nome nunca visto, mas parecido com produto existente ──
        // O código do SEFAZ é interno de cada loja — duas lojas raramente usam
        // o mesmo código pro mesmo produto. Por isso só pulamos o fuzzy quando
        // o código deste item já corresponde a um produto conhecido (aí o
        // fluxo padrão por código já resolve); ou quando o nome normalizado já
        // existe exatamente igual (idem, fluxo padrão resolve).
        const codigoJaConhecido = item.codigo && produtosPorCodigo.has(item.codigo);

        if (!codigoJaConhecido && !produtosPorNomeNorm.has(nomeNorm)) {
          const achados = fuse
            .search(nomeNorm)
            .filter((r) => r.score <= FUZZY_THRESHOLD)
            .sort((a, b) => a.score - b.score);

          if (achados.length > 0) {
            fuzzyMergedCount++;
            return aplicarFuzzyMerge(item, nomeNorm, achados[0].item);
          }
        }
        // ─────────────────────────────────────────────────────────────────────

        // Fluxo padrão: upsert normal
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

    const result = await purchases.insertOne(purchase);
    console.log('[savePurchase] Documento inserido com sucesso:', result.insertedId);

    const autoMerged = itensEnriquecidos.filter((i) => i.descricao_original).length;
    return { duplicate: false, auto_merged: autoMerged, fuzzy_merged: fuzzyMergedCount };
  } catch (error) {
    console.error('[savePurchase] Erro ao salvar:', error.message, error.stack);
    throw error;
  }
};


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
  return Math.round((vt / qt) * 100) / 100; // 2 casas
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
  // CORS headers
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
    // Fetch the SEFAZ page
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Falha ao obter a página da SEFAZ-MG.' });
    }

    const html = await response.text();
    const resultado = parseHtml(html);
    
    // Save to MongoDB
    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) {
      return res.status(409).json({ error: 'Nota já registrada anteriormente.', duplicate: true });
    }

    return res.json({
      ...resultado,
      auto_merged: saveResult?.auto_merged ?? 0,
      fuzzy_merged: saveResult?.fuzzy_merged ?? 0,
    });
  } catch (err) {
    console.error(`[${req.method} /api/consulta-qrcode] Erro:`, err.message);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}
