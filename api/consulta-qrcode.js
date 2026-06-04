import { load } from 'cheerio';

export default async function handler(req, res) {
  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  if (!url) {
    return res.status(400).json({ error: 'Parâmetro "url" é obrigatório.' });
  }

  try {
    // Fetch the SEFAZ page
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Falha ao obter a página da SEFAZ-MG.' });
    }

    const html = await response.text();
    const $ = load(html);

    const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

    const extractTableRow = ($table) => {
      const row = $table.find('tbody tr').first();
      return row.find('td').toArray().map((td) => normalizeText($(td).text()));
    };

    const emitenteSection = $("h5:contains('Emitente')").first();
    const emitenteTable = emitenteSection.nextAll('table').first();
    const emitenteCells = extractTableRow(emitenteTable);

    const dataEmissaoTable = $("th:contains('Data Emissão')").closest('table');
    const dataEmissaoCells = extractTableRow(dataEmissaoTable);

    const valorTotalServicoTable = $("th:contains('Valor total do serviço')").closest('table');
    const valorTotalServicoCells = extractTableRow(valorTotalServicoTable);

    const protocoloTable = $("th:contains('Protocolo')").closest('table');
    const protocoloCells = extractTableRow(protocoloTable);

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

    const result = {
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

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}
