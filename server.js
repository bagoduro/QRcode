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
    preco_unitario: calcPrecoUnitario(cols[3].replace(/.*?:\s*/, ''), cols[1].replace(/.*?:\s*/, '')),
  };
};

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

    // Upsert cada item no catálogo de produtos e enriquecer com product_id + nome_normalizado
    const itensEnriquecidos = await Promise.all(
      resultado.itens.map(async (item) => {
        const productId = await upsertProduct(db, item);
        return {
          ...item,
          descricao_normalizada: normalizeProductName(item.descricao),
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
    return { duplicate: false };
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
    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) {
      return res.status(409).json({ error: 'Nota já registrada anteriormente.', duplicate: true });
    }
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
    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) {
      return res.status(409).json({ error: 'Nota já registrada anteriormente.', duplicate: true });
    }
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
  const { produto, codigo, recorrentes, min_compras, comparar } = req.query;

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');

  // Sugestões: retorna lista de produtos distintos que batem com o termo
  const { sugestoes } = req.query;
  if (sugestoes === 'true' && produto) {
    const termoNorm = produto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

    const pipeline = [
      {
        $match: {
          $or: [
            { 'itens.descricao_normalizada': { $regex: termoNorm, $options: 'i' } },
            { 'itens.descricao': { $regex: produto, $options: 'i' } },
          ],
        },
      },
      { $unwind: '$itens' },
      {
        $match: {
          $or: [
            { 'itens.descricao_normalizada': { $regex: termoNorm, $options: 'i' } },
            { 'itens.descricao': { $regex: produto, $options: 'i' } },
          ],
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$itens.descricao_normalizada', { $toLower: '$itens.descricao' }] },
          descricao_original: { $first: '$itens.descricao' },
          codigo: { $first: '$itens.codigo' },
          vezes: { $sum: 1 },
          menor_preco_unitario: {
            $min: { $ifNull: ['$itens.preco_unitario', null] },
          },
          ultimo_valor: { $last: '$itens.valor_total' },
          ultimo_local: { $last: '$emitente.nome' },
        },
      },
      { $sort: { vezes: -1 } },
      { $limit: 10 },
    ];

    const sugestoesList = await purchases.aggregate(pipeline).toArray();

    return res.json({
      termo: produto,
      total: sugestoesList.length,
      sugestoes: sugestoesList.map((s) => ({
        descricao: s.descricao_original,
        descricao_normalizada: s._id,
        codigo: s.codigo,
        vezes: s.vezes,
        menor_preco_unitario: s.menor_preco_unitario,
        ultimo_valor: s.ultimo_valor,
        ultimo_local: s.ultimo_local,
      })),
    });
  }

  // Caso especial: comparar preços de um produto entre estabelecimentos
  const { comparar } = req.query;
  if (comparar && (produto || codigo)) {
    const matchStage = {};
    if (codigo) {
      matchStage['itens.codigo'] = codigo;
    } else {
      matchStage['itens.descricao_normalizada'] = {
        $regex: produto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
        $options: 'i',
      };
    }

    const pipeline = [
      { $match: matchStage },
      { $unwind: '$itens' },
      ...(codigo
        ? [{ $match: { 'itens.codigo': codigo } }]
        : [{
            $match: {
              'itens.descricao_normalizada': {
                $regex: produto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
                $options: 'i',
              },
            },
          }]),
      {
        $group: {
          _id: '$emitente.cnpj',
          local: { $first: '$emitente.nome' },
          cnpj: { $first: '$emitente.cnpj' },
          uf: { $first: '$emitente.uf' },
          vezes_comprado: { $sum: 1 },
          menor_valor: { $min: { $toDouble: { $ifNull: ['$itens._valor_num', 0] } } },
          ultimo_valor: { $last: '$itens.valor_total' },
          ultima_data: { $max: '$createdAt' },
          ocorrencias: {
            $push: {
              data_compra: '$nota.data_emissao',
              createdAt: '$createdAt',
              valor_total: '$itens.valor_total',
              quantidade: '$itens.quantidade',
            },
          },
        },
      },
      { $sort: { vezes_comprado: -1, ultima_data: -1 } },
    ];

    const lojas = await purchases.aggregate(pipeline).toArray();

    // Calcular menor preço real em JS (parseValor é mais confiável que $toDouble)
    const lojasEnriquecidas = lojas.map((loja) => {
      const ocorrencias = [...loja.ocorrencias].sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      const menorOcorrencia = loja.ocorrencias.reduce((menor, atual) => {
        return parseValor(atual.valor_total) < parseValor(menor.valor_total) ? atual : menor;
      }, loja.ocorrencias[0]);

      return {
        local: loja.local,
        cnpj: loja.cnpj,
        uf: loja.uf,
        vezes_comprado: loja.vezes_comprado,
        ultimo_valor: ocorrencias[0]?.valor_total,
        ultima_data: ocorrencias[0]?.data_compra,
        menor_valor: menorOcorrencia?.valor_total,
        ocorrencias,
      };
    });

    // Ordenar por menor preço encontrado
    const lojasOrdenadas = [...lojasEnriquecidas].sort(
      (a, b) => parseValor(a.menor_valor) - parseValor(b.menor_valor)
    );

    return res.json({
      produto: produto || codigo,
      total_lojas: lojasOrdenadas.length,
      lojas: lojasOrdenadas,
    });
  }

    // Caso 1: buscar histórico de um produto específico (por nome ou código)
    if (produto || codigo) {
      const matchStage = {};

      if (codigo) {
        matchStage['itens.codigo'] = codigo;
      } else if (produto) {
        matchStage['$or'] = [
          { 'itens.descricao_normalizada': { $regex: produto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(), $options: 'i' } },
          { 'itens.descricao': { $regex: produto, $options: 'i' } },
        ];
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

app.delete('/historico-compras', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Parâmetro "url" é obrigatório.' });
  }

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');

    const result = await purchases.deleteOne({ url });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Nota não encontrada.' });
    }

    return res.json({ success: true, message: 'Nota excluída com sucesso.' });
  } catch (err) {
    console.error('[DELETE /historico-compras] Erro:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
});


// GET /mesclar-produtos — histórico de mesclagens
app.get('/mesclar-produtos', async (req, res) => {
  try {
    const db = await getDb();
    const mergeLog = db.collection('merge_log');
    const historico = await mergeLog.find({}).sort({ createdAt: -1 }).limit(50).toArray();
    return res.json({ total: historico.length, historico });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /mesclar-produtos?id=... — reverter mesclagem
app.delete('/mesclar-produtos', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Informe o "id".' });
  try {
    const db = await getDb();
    const { ObjectId } = await import('mongodb');
    const oid = new ObjectId(id);
    const purchases = db.collection('purchases');
    const products  = db.collection('products');
    const mergeLog  = db.collection('merge_log');

    const entrada = await mergeLog.findOne({ _id: oid });
    if (!entrada) return res.status(404).json({ error: 'Mesclagem não encontrada.' });

    let notasRevertidas = 0;
    for (const snap of entrada.snapshot) {
      for (const itemSnap of snap.itens) {
        const result = await purchases.updateOne(
          { _id: snap.purchaseId },
          { $set: {
            [`itens.${itemSnap.idx}.descricao`]: itemSnap.descricao,
            [`itens.${itemSnap.idx}.descricao_normalizada`]: itemSnap.descricao_normalizada,
            [`itens.${itemSnap.idx}.product_id`]: itemSnap.product_id,
          }}
        );
        if (result.modifiedCount > 0) notasRevertidas++;
      }
    }

    for (const prod of entrada.produtos_antigos) {
      await products.updateOne({ nome_normalizado: prod.nome_normalizado }, { $setOnInsert: prod }, { upsert: true });
    }

    if (!entrada.nome_final_preexistia) {
      const nomeFinalNorm = entrada.nome_final.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      await products.deleteOne({ nome_normalizado: nomeFinalNorm });
    }

    await mergeLog.deleteOne({ _id: oid });
    return res.json({ ok: true, notas_revertidas: notasRevertidas });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.listen(port, () => {
  console.log(`Backend NFC-e rodando em http://localhost:${port}`);
  console.log('[Startup] Variáveis de ambiente:');
  console.log('[Startup] PORT:', port);
  console.log('[Startup] MONGO_URI definida:', !!process.env.MONGO_URI);
  console.log('[Startup] MONGO_DB_NAME:', process.env.MONGO_DB_NAME || 'leitor_qr (padrão)');
});

// POST /mesclar-produtos
app.post('/mesclar-produtos', async (req, res) => {
  const { descricoes, nome_final } = req.body || {};

  if (!Array.isArray(descricoes) || descricoes.length < 2) {
    return res.status(400).json({ error: 'Informe ao menos 2 produtos em "descricoes".' });
  }
  if (!nome_final || !nome_final.trim()) {
    return res.status(400).json({ error: 'Informe o "nome_final" para o produto mesclado.' });
  }

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const products  = db.collection('products');

    const nomeFinal = nome_final.trim();
    const nomeFinalNorm = nomeFinal
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    await products.updateOne(
      { nome_normalizado: nomeFinalNorm },
      {
        $setOnInsert: { createdAt: new Date(), codigo: null },
        $set: { nome_original: nomeFinal, nome_normalizado: nomeFinalNorm, updatedAt: new Date() },
      },
      { upsert: true }
    );
    const produtoCanonico = await products.findOne({ nome_normalizado: nomeFinalNorm });

    let totalAtualizados = 0;
    for (const descricao of descricoes) {
      const result = await purchases.updateMany(
        { 'itens.descricao': descricao },
        {
          $set: {
            'itens.$[elem].descricao': nomeFinal,
            'itens.$[elem].descricao_normalizada': nomeFinalNorm,
            'itens.$[elem].product_id': produtoCanonico._id,
          },
        },
        { arrayFilters: [{ 'elem.descricao': descricao }] }
      );
      totalAtualizados += result.modifiedCount;
    }

    const descNormsAntigas = descricoes
      .map((d) => d.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((n) => n !== nomeFinalNorm);
    await products.deleteMany({ nome_normalizado: { $in: descNormsAntigas } });

    return res.json({ ok: true, nome_final: nomeFinal, produtos_mesclados: descricoes.length, notas_atualizadas: totalAtualizados });
  } catch (err) {
    console.error('[POST /mesclar-produtos] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
});
