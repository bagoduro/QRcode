import 'dotenv/config';
import express from 'express';
import { load } from 'cheerio';
import { getDb } from './db.js';

const app = express();
const port = process.env.PORT || 3333;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

const parseItemRow = (row, $) => {
  const cols = $(row)
    .find('td')
    .toArray()
    .map((td) => normalizeText($(td).text()));
  if (cols.length < 4) return null;

  const itemMatch = cols[0].match(/^(.*?)\s*\(Código:\s*([^\)]+)\)/i);
  return {
    descricao: itemMatch ? normalizeText(itemMatch[1]) : cols[0],
    codigo: itemMatch ? normalizeText(itemMatch[2]) : null,
    quantidade: cols[1].replace(/.*?:\s*/, ''),
    unidade: cols[2].replace(/.*?:\s*/, ''),
    valor_total: cols[3].replace(/.*?:\s*/, ''),
  };
};

const savePurchase = async (url, resultado) => {
  try {
    console.log('[savePurchase] Iniciando salvamento...', { url });
    const db = await getDb();
    console.log('[savePurchase] Conectado ao banco');
    const purchases = db.collection('purchases');
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
    const item = parseItemRow(row, $);
    if (item) itens.push(item);
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

const fetchAndParseUrl = async (url) => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
  });

  if (!response.ok) {
    const message = `Falha ao obter a página da SEFAZ-MG: ${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  const html = await response.text();
  return parseHtml(html);
};

app.post('/consulta-qrcode', async (req, res) => {
  const { url } = req.body;
  console.log('[POST /consulta-qrcode] Requisição recebida:', { url });
  
  if (!url) {
    return res.status(400).json({ error: 'A propriedade "url" é obrigatória.' });
  }

  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({ error: 'URL inválida.' });
  }

  try {
    const resultado = await fetchAndParseUrl(url);
    await savePurchase(url, resultado);
    return res.json(resultado);
  } catch (error) {
    console.error('[POST /consulta-qrcode] Erro:', error.message);
    return res.status(500).json({ error: 'Erro interno no servidor.', details: error.message });
  }
});

app.get('/', (req, res) => {
  res.type('text/plain').send(
    'API NFC-e backend. Use GET /consulta-qrcode?url=<URL> ou POST /consulta-qrcode com { "url": "..." }'
  );
});

app.get('/consulta-qrcode', async (req, res) => {
  const { url } = req.query;
  console.log('[GET /consulta-qrcode] Requisição recebida:', { url });
  
  if (!url) {
    return res.status(400).json({ error: 'O parâmetro "url" é obrigatório.' });
  }

  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({ error: 'URL inválida.' });
  }

  try {
    const resultado = await fetchAndParseUrl(url);
    await savePurchase(url, resultado);
    return res.json(resultado);
  } catch (error) {
    console.error('[GET /consulta-qrcode] Erro:', error.message);
    return res.status(500).json({ error: 'Erro interno no servidor.', details: error.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: 'ok', db: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

const parseValor = (valor) => {
  if (!valor) return Infinity;
  const limpo = String(valor)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3},)/g, '')
    .replace(',', '.');
  const numero = parseFloat(limpo);
  return isNaN(numero) ? Infinity : numero;
};

app.get('/historico-compras', async (req, res) => {
  const { produto, codigo, recorrentes, min_compras } = req.query;

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');

    // Caso 1: buscar histórico de um produto específico (por nome ou código)
    if (produto || codigo) {
      const matchStage = {};

      if (codigo) {
        matchStage['itens.codigo'] = codigo;
      } else if (produto) {
        matchStage['itens.descricao'] = { $regex: produto, $options: 'i' };
      }

      const pipeline = [
        { $match: matchStage },
        { $unwind: '$itens' },
        ...(codigo
          ? [{ $match: { 'itens.codigo': codigo } }]
          : [{ $match: { 'itens.descricao': { $regex: produto, $options: 'i' } } }]),
        {
          $project: {
            _id: 0,
            data_compra: '$nota.data_emissao',
            createdAt: 1,
            local: '$emitente.nome',
            cnpj: '$emitente.cnpj',
            uf: '$emitente.uf',
            descricao: '$itens.descricao',
            codigo: '$itens.codigo',
            quantidade: '$itens.quantidade',
            unidade: '$itens.unidade',
            valor_total: '$itens.valor_total',
          },
        },
        { $sort: { createdAt: -1 } },
      ];

      const historico = await purchases.aggregate(pipeline).toArray();

      if (historico.length === 0) {
        return res.json({
          produto: produto || codigo,
          ultima_compra: null,
          menor_preco: null,
          historico: [],
        });
      }

      const ultimaCompra = historico[0];

      const menorPreco = historico.reduce((menor, atual) => {
        const valorAtual = parseValor(atual.valor_total);
        const valorMenor = parseValor(menor.valor_total);
        return valorAtual < valorMenor ? atual : menor;
      }, historico[0]);

      return res.json({
        produto: produto || codigo,
        ultima_compra: ultimaCompra,
        menor_preco: menorPreco,
        historico,
      });
    }

    // Caso 2: itens recorrentes
    if (recorrentes === 'true') {
      const minCompras = parseInt(min_compras, 10) || 2;

      const pipeline = [
        { $unwind: '$itens' },
        {
          $group: {
            _id: {
              codigo: '$itens.codigo',
              descricao: '$itens.descricao',
            },
            descricao: { $last: '$itens.descricao' },
            codigo: { $last: '$itens.codigo' },
            vezes_comprado: { $sum: 1 },
            ultima_data: { $max: '$createdAt' },
            ultimo_local: { $last: '$emitente.nome' },
            ultimo_valor: { $last: '$itens.valor_total' },
            ocorrencias: {
              $push: {
                createdAt: '$createdAt',
                local: '$emitente.nome',
                cnpj: '$emitente.cnpj',
                valor_total: '$itens.valor_total',
                data_compra: '$nota.data_emissao',
              },
            },
          },
        },
        { $match: { vezes_comprado: { $gte: minCompras } } },
        { $sort: { vezes_comprado: -1, ultima_data: -1 } },
      ];

      const grupos = await purchases.aggregate(pipeline).toArray();

      const itensRecorrentes = grupos.map((grupo) => {
        const ocorrenciasOrdenadas = [...grupo.ocorrencias].sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );

        const menorPreco = grupo.ocorrencias.reduce((menor, atual) => {
          const valorAtual = parseValor(atual.valor_total);
          const valorMenor = parseValor(menor.valor_total);
          return valorAtual < valorMenor ? atual : menor;
        }, grupo.ocorrencias[0]);

        return {
          descricao: grupo.descricao,
          codigo: grupo.codigo,
          vezes_comprado: grupo.vezes_comprado,
          ultima_compra: ocorrenciasOrdenadas[0],
          menor_preco: menorPreco,
        };
      });

      return res.json({
        criterio_minimo_compras: minCompras,
        total: itensRecorrentes.length,
        itens_recorrentes: itensRecorrentes,
      });
    }

    // Caso 3: listar histórico geral de compras (resumo por nota)
    const pipeline = [
      {
        $project: {
          _id: 0,
          url: 1,
          createdAt: 1,
          local: '$emitente.nome',
          cnpj: '$emitente.cnpj',
          data_compra: '$nota.data_emissao',
          valor_pago: '$totais.valor_pago',
          valor_total: '$totais.valor_total',
          quantidade_itens: '$totais.quantidade_total_itens',
          itens: {
            $map: {
              input: '$itens',
              as: 'item',
              in: {
                descricao: '$$item.descricao',
                codigo: '$$item.codigo',
                quantidade: '$$item.quantidade',
                valor_total: '$$item.valor_total',
              },
            },
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ];

    const compras = await purchases.aggregate(pipeline).toArray();

    return res.json({ total: compras.length, compras });
  } catch (err) {
    console.error('[GET /historico-compras] Erro:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
});

app.listen(port, () => {
  console.log(`Backend NFC-e rodando em http://localhost:${port}`);
  console.log('[Startup] Variáveis de ambiente:');
  console.log('[Startup] PORT:', port);
  console.log('[Startup] MONGO_URI definida:', !!process.env.MONGO_URI);
  console.log('[Startup] MONGO_DB_NAME:', process.env.MONGO_DB_NAME || 'leitor_qr (padrão)');
});
