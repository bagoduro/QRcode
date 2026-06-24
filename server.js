import 'dotenv/config';
import express from 'express';
import { load } from 'cheerio';
import { getDb } from './db.js';
import authHandler, { verifyJwt } from './api/auth.js';
import Fuse from 'fuse.js';

// ── Middleware ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth  = req.headers?.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: 'Token inválido ou expirado.' });
  req.user = payload;
  next();
}

const app = express();
const port = process.env.PORT || 3333;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

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

// ─── AUTO-MERGE DE ITENS NOVOS (CORRIGIDO) ──────────────────────────────────
async function autoMergeNewItems(db, itensNovos) {
  const products = db.collection('products');
  const mergeRules = db.collection('merge_rules');
  const purchases = db.collection('purchases');

  console.log(`[autoMergeNewItems] Processando ${itensNovos.length} itens...`);

  for (const item of itensNovos) {
    const descNorm = normalizeProductName(item.descricao);

    // 1. Verifica se já existe regra para este item
    const existingRule = await mergeRules.findOne({
      descricao_original_normalizada: descNorm
    });
    if (existingRule) {
      console.log(`[autoMergeNewItems] Item "${item.descricao}" já tem regra, pulando.`);
      continue;
    }

    // 2. Busca todos os produtos (exceto ele mesmo)
    const allProducts = await products.find({
      nome_normalizado: { $ne: descNorm }
    }).toArray();

    console.log(`[autoMergeNewItems] Encontrados ${allProducts.length} produtos para comparar com "${item.descricao}"`);

    // Filtra produtos bloqueados (não podem ser âncora)
    const candidatos = allProducts.filter(p => p.block_auto_merge !== true);

    if (candidatos.length === 0) {
      console.log(`[autoMergeNewItems] Nenhum candidato disponível (todos bloqueados).`);
      continue;
    }

    const fuse = new Fuse(candidatos, {
      keys: ['nome_original', 'nome_normalizado'],
      threshold: 0.35, // Ajustei para ficar mais sensível
      includeScore: true,
      ignoreLocation: true,
    });

    const similares = fuse.search(item.descricao).filter(r => r.score <= 0.35);

    console.log(`[autoMergeNewItems] Encontrados ${similares.length} similares para "${item.descricao}"`);

    if (similares.length > 0) {
      const ancora = similares[0].item;
      console.log(`[autoMergeNewItems] Âncora escolhida: "${ancora.nome_original}" (score: ${similares[0].score})`);

      // Cria regra de mesclagem
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

      // Atualiza compras antigas que tenham esse item (sem descricao_original)
      await purchases.updateMany(
        { 'itens.descricao': item.descricao, 'itens.descricao_original': { $exists: false } },
        { $set: { 'itens.$[elem].descricao_original': item.descricao } },
        { arrayFilters: [{ 'elem.descricao': item.descricao }] }
      );

      // Atualiza todas as ocorrências desse item para o nome final
      const updateResult = await purchases.updateMany(
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

      console.log(`[autoMergeNewItems] Item "${item.descricao}" mesclado com "${ancora.nome_original}" (${updateResult.modifiedCount} ocorrências atualizadas)`);
    } else {
      console.log(`[autoMergeNewItems] Nenhum similar encontrado para "${item.descricao}"`);
    }
  }
}

// ─── SALVAR COMPRA ────────────────────────────────────────────────────────────
const savePurchase = async (url, resultado) => {
  try {
    console.log('[savePurchase] Iniciando salvamento...', { url });
    const db = await getDb();
    const purchases = db.collection('purchases');
    const mergeRules = db.collection('merge_rules');

    const existing = await purchases.findOne({ url });
    if (existing) {
      console.log('[savePurchase] URL já registrada, ignorando duplicata.');
      return { duplicate: true };
    }

    // Guarda os itens originais (antes de aplicar regras) para o auto‑merge posterior
    const itensOriginais = resultado.itens.map(item => ({ ...item }));

    const regras = await mergeRules.find({}).toArray();
    const mapRegras = new Map(regras.map(r => [r.descricao_original_normalizada, r]));

    const itensEnriquecidos = await Promise.all(
      resultado.itens.map(async (item) => {
        const normOriginal = normalizeProductName(item.descricao);
        const regra = mapRegras.get(normOriginal);
        
        let descricaoFinal = item.descricao;
        let descricaoNormFinal = normOriginal;
        let productId = null;
        let descOriginalPreservada = undefined;

        if (regra) {
          descricaoFinal = regra.nome_final;
          descricaoNormFinal = regra.nome_final_normalizado;
          productId = regra.product_id;
          descOriginalPreservada = item.descricao;
        } else {
          productId = await upsertProduct(db, item);
        }

        return {
          ...item,
          descricao: descricaoFinal,
          descricao_normalizada: descricaoNormFinal,
          product_id: productId,
          ...(descOriginalPreservada && { descricao_original: descOriginalPreservada })
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

    // ─── AUTO‑MERGE DE ITENS NOVOS ──────────────────────────────────────────
    console.log('[savePurchase] Iniciando auto‑merge para itens novos...');
    await autoMergeNewItems(db, itensOriginais);

    return { duplicate: false };
  } catch (error) {
    console.error('[savePurchase] Erro ao salvar:', error.message, error.stack);
    throw error;
  }
};

// ─── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────
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

// ─── PARSE HTML ──────────────────────────────────────────────────────────────
const parseHtml = (html) => {
  const $ = load(html);

  const emitenteSection = $("h5:contains('Emitente')").first();
  const emitenteTable = emitenteSection.nextAll('table').first();
  const emitenteCells = emitenteTable.length ? emitenteTable.find('tbody tr').first().find('td').toArray().map(td => normalizeText($(td).text())) : [];

  const dataEmissaoTable = $("th:contains('Data Emissão')").closest('table');
  const dataEmissaoCells = dataEmissaoTable.length ? dataEmissaoTable.find('tbody tr').first().find('td').toArray().map(td => normalizeText($(td).text())) : [];

  const valorTotalServicoTable = $("th:contains('Valor total do serviço')").closest('table');
  const valorTotalServicoCells = valorTotalServicoTable.length ? valorTotalServicoTable.find('tbody tr').first().find('td').toArray().map(td => normalizeText($(td).text())) : [];

  const protocoloTable = $("th:contains('Protocolo')").closest('table');
  const protocoloCells = protocoloTable.length ? protocoloTable.find('tbody tr').first().find('td').toArray().map(td => normalizeText($(td).text())) : [];

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
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!response.ok) throw new Error(`Falha ao obter a página da SEFAZ-MG: ${response.status}`);
  const html = await response.text();
  return parseHtml(html);
};

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.post('/consulta-qrcode', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'A propriedade "url" é obrigatória.' });
  try {
    const resultado = await fetchAndParseUrl(url);
    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) return res.status(409).json({ error: 'Nota já registrada anteriormente.', duplicate: true });
    return res.json(resultado);
  } catch (error) {
    return res.status(500).json({ error: 'Erro interno no servidor.', details: error.message });
  }
});

app.get('/consulta-qrcode', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'O parâmetro "url" é obrigatória.' });
  try {
    const resultado = await fetchAndParseUrl(url);
    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) return res.status(409).json({ error: 'Nota já registrada anteriormente.', duplicate: true });
    return res.json(resultado);
  } catch (error) {
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
  const limpo = String(valor).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3},)/g, '').replace(',', '.');
  const numero = parseFloat(limpo);
  return isNaN(numero) ? Infinity : numero;
};

app.get('/historico-compras', async (req, res) => {
  const { produto, codigo, recorrentes, min_compras, sugestoes } = req.query;
  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const mergeRules = db.collection('merge_rules');

    if (sugestoes === 'true' && produto) {
      const termoNorm = normalizeProductName(produto);
      const pipeline = [
        { $match: { $or: [{ 'itens.descricao_normalizada': { $regex: termoNorm, $options: 'i' } }, { 'itens.descricao': { $regex: produto, $options: 'i' } }] } },
        { $unwind: '$itens' },
        { $match: { $or: [{ 'itens.descricao_normalizada': { $regex: termoNorm, $options: 'i' } }, { 'itens.descricao': { $regex: produto, $options: 'i' } }] } },
        {
          $group: {
            _id: { $ifNull: ['$itens.descricao_normalizada', { $toLower: '$itens.descricao' }] },
            descricao_original: { $first: '$itens.descricao' },
            codigo: { $first: '$itens.codigo' },
            vezes: { $sum: 1 },
            menor_preco_unitario: { $min: { $ifNull: ['$itens.preco_unitario', null] } },
            ultimo_valor: { $last: '$itens.valor_total' },
            ultimo_local: { $last: '$emitente.nome' },
          },
        },
        { $sort: { vezes: -1 } },
        { $limit: 10 },
      ];
      const list = await purchases.aggregate(pipeline).toArray();
      const norms = list.map(s => s._id).filter(Boolean);
      const rules = await mergeRules.find({ nome_final_normalizado: { $in: norms } }).toArray();
      const mesclados = new Set(rules.map(r => r.nome_final_normalizado));
      return res.json({
        termo: produto,
        sugestoes: list.map(s => ({ ...s, descricao: s.descricao_original, descricao_normalizada: s._id, mesclado: mesclados.has(s._id) }))
      });
    }

    if (produto || codigo) {
      const match = codigo ? { 'itens.codigo': codigo } : { $or: [{ 'itens.descricao_normalizada': normalizeProductName(produto) }, { 'itens.descricao': { $regex: produto, $options: 'i' } }] };
      const pipeline = [
        { $match: match },
        { $unwind: '$itens' },
        ...(codigo ? [{ $match: { 'itens.codigo': codigo } }] : [{ $match: { 'itens.descricao': { $regex: produto, $options: 'i' } } }]),
        { $project: { _id: 0, data_compra: '$nota.data_emissao', createdAt: 1, local: '$emitente.nome', descricao: '$itens.descricao', valor_total: '$itens.valor_total' } },
        { $sort: { createdAt: -1 } }
      ];
      const hist = await purchases.aggregate(pipeline).toArray();
      const rule = await mergeRules.findOne({ nome_final_normalizado: normalizeProductName(produto || '') });
      return res.json({ produto: produto || codigo, historico: hist, mesclado: !!rule });
    }

    const pipeline = [{ $project: { _id: 0, url: 1, createdAt: 1, local: '$emitente.nome', data_compra: '$nota.data_emissao', valor_total: '$totais.valor_total' } }, { $sort: { createdAt: -1 } }];
    const compras = await purchases.aggregate(pipeline).toArray();
    return res.json({ total: compras.length, compras });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/historico-compras', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Parâmetro "url" é obrigatório.' });
  try {
    const db = await getDb();
    const result = await db.collection('purchases').deleteOne({ url });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Nota não encontrada.' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINT DE MIGRAÇÃO ---
app.post('/api/migrate', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const purchases  = db.collection('purchases');
    const products   = db.collection('products');
    const mergeRules = db.collection('merge_rules');

    const pipeline = [
      { $unwind: '$itens' },
      {
        $group: {
          _id: '$itens.descricao_normalizada',
          descricao: { $first: '$itens.descricao' },
          vezes: { $sum: 1 }
        }
      }
    ];

    const todosProdutos = await purchases.aggregate(pipeline).toArray();
    const listaParaFuse = todosProdutos.map(p => ({
      descricao: p.descricao,
      descricao_normalizada: p._id,
      vezes: p.vezes
    }));

    function sugerirGrupoDuplicado(lista) {
      if (!lista || lista.length < 2) return null;
      const restante = [...lista];
      restante.sort((a, b) => (b.vezes || 0) - (a.vezes || 0));
      const ancora = restante[0];
      const fuse = new Fuse(restante, { keys: ['descricao'], threshold: 0.4 });
      const achados = fuse.search(ancora.descricao).filter(r => r.score <= 0.4).map(r => r.item);
      return achados.length >= 2 ? { ancora, itens: achados } : null;
    }

    let gruposMesclados = 0;
    let atual = listaParaFuse;
    while (true) {
      const grupo = sugerirGrupoDuplicado(atual);
      if (!grupo) break;

      const nomeFinal = grupo.ancora.descricao;
      const nomeFinalNorm = normalizeProductName(nomeFinal);
      const descricoesOriginais = grupo.itens.map(i => i.descricao);

      await products.updateOne({ nome_normalizado: nomeFinalNorm }, { $setOnInsert: { createdAt: new Date(), codigo: null }, $set: { nome_original: nomeFinal, nome_normalizado: nomeFinalNorm, updatedAt: new Date() } }, { upsert: true });
      const prod = await products.findOne({ nome_normalizado: nomeFinalNorm });

      for (const desc of descricoesOriginais) {
        if (normalizeProductName(desc) === nomeFinalNorm) continue;
        const descNorm = normalizeProductName(desc);
        await mergeRules.updateOne({ descricao_original_normalizada: descNorm }, { $set: { descricao_original: desc, descricao_original_normalizada: descNorm, nome_final: nomeFinal, nome_final_normalizado: nomeFinalNorm, product_id: prod._id, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
        await purchases.updateMany({ 'itens.descricao': desc, 'itens.descricao_original': { $exists: false } }, { $set: { 'itens.$[elem].descricao_original': desc } }, { arrayFilters: [{ 'elem.descricao': desc }] });
        await purchases.updateMany({ 'itens.descricao': desc }, { $set: { 'itens.$[elem].descricao': nomeFinal, 'itens.$[elem].descricao_normalizada': nomeFinalNorm, 'itens.$[elem].product_id': prod._id } }, { arrayFilters: [{ 'elem.descricao': desc }] });
      }
      gruposMesclados++;
      const set = new Set(descricoesOriginais);
      atual = atual.filter(i => !set.has(i.descricao));
    }

    return res.json({ ok: true, grupos_mesclados: gruposMesclados });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth', authHandler);
app.get('/api/auth', authHandler);

// ── BLACKLIST DE AUTO-MERGE ─────────────────────────────────────────────
app.get('/api/auto-merge-blacklist', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const blocked = await db.collection('products').find({ block_auto_merge: true }).toArray();
    res.json({ itens: blocked.map(b => b.nome_normalizado) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TOGGLE-BLOCK ──────────────────────────────────────────────────────────
app.post('/api/toggle-block', requireAuth, async (req, res) => {
  const { nome_normalizado, blocked } = req.body;
  if (!nome_normalizado) {
    return res.status(400).json({ error: 'Faltando "nome_normalizado"' });
  }
  try {
    const db = await getDb();
    const result = await db.collection('products').updateOne(
      { nome_normalizado },
      { $set: { block_auto_merge: blocked === true } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    res.json({ ok: true, blocked: blocked === true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MESCLAGEM ─────────────────────────────────────────────────────────────
app.post('/mesclar-produtos', requireAuth, async (req, res) => {
  const {
    action,
    descricoes,
    nome_final,
    descricao_mesclada,
    autoMerge = false
  } = req.body || {};
  const db = await getDb();
  const purchases = db.collection('purchases');
  const products = db.collection('products');
  const mergeRules = db.collection('merge_rules');

  // ── DESFAZER MESCLAGEM ──────────────────────────────────────────────────────
  if (action === 'unmerge') {
    const pipeline = [
      { $unwind: '$itens' },
      { $match: { 'itens.descricao': descricao_mesclada, 'itens.descricao_original': { $exists: true } } },
      { $group: { _id: null, originais: { $addToSet: '$itens.descricao_original' } } }
    ];
    const resAgg = await purchases.aggregate(pipeline).toArray();
    if (resAgg.length === 0) return res.status(404).json({ error: 'Não encontrado' });

    const originais = resAgg[0].originais;
    for (const desc of originais) {
      const dNorm = normalizeProductName(desc);
      await products.updateOne(
        { nome_normalizado: dNorm },
        {
          $set: {
            nome_original: desc,
            nome_normalizado: dNorm,
            updatedAt: new Date(),
            block_auto_merge: true
          }
        },
        { upsert: true }
      );
      const p = await products.findOne({ nome_normalizado: dNorm });
      await purchases.updateMany(
        { 'itens.descricao': descricao_mesclada, 'itens.descricao_original': desc },
        {
          $set: {
            'itens.$[elem].descricao': desc,
            'itens.$[elem].descricao_normalizada': dNorm,
            'itens.$[elem].product_id': p._id
          },
          $unset: { 'itens.$[elem].descricao_original': "" }
        },
        { arrayFilters: [{ 'elem.descricao': descricao_mesclada, 'elem.descricao_original': desc }] }
      );
    }

    const nomeFinalNorm = normalizeProductName(descricao_mesclada);
    await mergeRules.deleteMany({ nome_final_normalizado: nomeFinalNorm });

    return res.json({ ok: true });
  }

  // ── MESCLAR PRODUTOS (PADRÃO) ──────────────────────────────────────────────
  if (autoMerge) {
    for (const desc of descricoes) {
      const dNorm = normalizeProductName(desc);
      const product = await products.findOne({
        nome_normalizado: dNorm
      });

      if (product?.block_auto_merge === true) {
        return res.status(409).json({
          blocked: true,
          error: `Produto "${desc}" está bloqueado para mesclagem automática.`
        });
      }
    }
  }

  const nomeFinal = nome_final.trim();
  const nomeFinalNorm = normalizeProductName(nomeFinal);

  await products.updateOne(
    { nome_normalizado: nomeFinalNorm },
    {
      $set: {
        nome_original: nomeFinal,
        nome_normalizado: nomeFinalNorm,
        updatedAt: new Date(),
        block_auto_merge: true
      },
      $setOnInsert: { createdAt: new Date(), codigo: null }
    },
    { upsert: true }
  );
  const prod = await products.findOne({ nome_normalizado: nomeFinalNorm });

  for (const desc of descricoes) {
    await purchases.updateMany(
      { 'itens.descricao': desc, 'itens.descricao_original': { $exists: false } },
      { $set: { 'itens.$[elem].descricao_original': desc } },
      { arrayFilters: [{ 'elem.descricao': desc }] }
    );
    await purchases.updateMany(
      { 'itens.descricao': desc },
      {
        $set: {
          'itens.$[elem].descricao': nomeFinal,
          'itens.$[elem].descricao_normalizada': nomeFinalNorm,
          'itens.$[elem].product_id': prod._id,
        },
      },
      { arrayFilters: [{ 'elem.descricao': desc }] }
    );
    if (normalizeProductName(desc) !== nomeFinalNorm) {
      const dNorm = normalizeProductName(desc);
      await mergeRules.updateOne(
        { descricao_original_normalizada: dNorm },
        {
          $set: {
            descricao_original: desc,
            nome_final: nomeFinal,
            nome_final_normalizado: nomeFinalNorm,
            product_id: prod._id,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
      await products.updateOne(
        { nome_normalizado: dNorm },
        { $set: { block_auto_merge: false } }
      );
    }
  }

  return res.json({ ok: true });
});

app.get('/api/mesclar-produtos', requireAuth, async (req, res) => {
  const db = await getDb();
  const rules = await db.collection('merge_rules').find({}).toArray();
  const groups = new Map();
  for (const r of rules) {
    if (!groups.has(r.nome_final_normalizado)) groups.set(r.nome_final_normalizado, { nome_final: r.nome_final, origens: [] });
    groups.get(r.nome_final_normalizado).origens.push({ descricao: r.descricao_original });
  }
  return res.json({ ok: true, mesclagens: [...groups.values()] });
});

app.listen(port, () => console.log(`Rodando em http://localhost:${port}`));