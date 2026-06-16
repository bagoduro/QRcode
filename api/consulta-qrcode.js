import 'dotenv/config';
import { load } from 'cheerio';
import { getDb } from '../db.js';

const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

const savePurchase = async (url, resultado) => {
  try {
    console.log('[savePurchase] Iniciando salvamento...', { url });
    const db = await getDb();
    console.log('[savePurchase] Conectado ao banco');
    const purchases = db.collection('purchases');

    const existing = await purchases.findOne({ url });
    if (existing) {
      console.log('[savePurchase] URL já registrada, ignorando duplicata.');
      return { duplicate: true };
    }

    const purchase = {
      url,
      createdAt: new Date(),
      emitente: resultado.emitente,
      nota: resultado.nota,
      chave_acesso: resultado.chave_acesso,
      totais: resultado.totais,
      itens: resultado.itens,
    };

    const result = await purchases.insertOne(purchase);
    console.log('[savePurchase] Documento inserido com sucesso:', result.insertedId);
    return { duplicate: false };
  } catch (error) {
    console.error('[savePurchase] Erro ao salvar:', error.message, error.stack);
    throw error;
  }
};

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

    return res.json(resultado);
  } catch (err) {
    console.error(`[${req.method} /api/consulta-qrcode] Erro:`, err.message);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}
