import 'dotenv/config';
import { load } from 'cheerio';
import Fuse from 'fuse.js';
import { getDb } from '../db.js';

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
const FUZZY_THRESHOLD = 0.4; // seguro
const CLUSTER_THRESHOLD = 0.35; // rigoroso
const MAX_GROUP_SIZE = 5; // limite de itens por grupo

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

// ─── FUNÇÃO DE CLUSTERIZAÇÃO COM LIMITE DE TAMANHO ────────────────────────
function sugerirGrupoDuplicado(lista, threshold = CLUSTER_THRESHOLD) {
  if (!lista || lista.length < 2) return null;

  const restante = [...lista];
  let melhorGrupo = null;

  while (restante.length >= 2) {
    restante.sort((a, b) => (b.vezes || 0) - (a.vezes || 0));
    const ancora = restante[0];

    const fuse = new Fuse(restante, {
      keys: ['descricao'],
      includeScore: true,
      threshold,
      ignoreLocation: true,
    });

    const achados = fuse
      .search(ancora.descricao)
      .filter((r) => r.score <= threshold)
      .map((r) => r.item);

    // 🔥 LIMITE: só forma grupo se tiver entre 2 e MAX_GROUP_SIZE itens
    if (achados.length >= 2 && achados.length <= MAX_GROUP_SIZE) {
      const grupo = { ancora, itens: achados };
      if (!melhorGrupo || grupo.itens.length > melhorGrupo.itens.length) {
        melhorGrupo = grupo;
      }
    }

    const descartar = new Set([ancora.descricao, ...achados.map((i) => i.descricao)]);
    for (let i = restante.length - 1; i >= 0; i--) {
      if (descartar.has(restante[i].descricao)) restante.splice(i, 1);
    }
  }

  return melhorGrupo;
}

// ─── UPSERT ──────────────────────────────────────────────────────────────────
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

// ─── CRIAR REGRA DE MESCLAGEM ──────────────────────────────────────────────
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

// ─── AUTO-MERGE SEGURO (COM VERIFICAÇÃO DE PALAVRAS‑CHAVE) ──────────────────
async function autoMergeNovosItens(db, itensNovos) {
  console.log('[autoMerge] Iniciando para', itensNovos.length, 'itens');
  const products = db.collection('products');
  const mergeRules = db.collection('merge_rules');
  const purchases = db.collection('purchases');

  try {
    const pipeline = [
      { $unwind: '$itens' },
      { $group: { _id: '$itens.product_id', vezes: { $sum: 1 } } }
    ];
    const contagem = await purchases.aggregate(pipeline).toArray();
    const mapContagem = new Map(contagem.map(c => [String(c._id), c.vezes]));

    for (const item of itensNovos) {
      try {
        const descNorm = normalizeProductName(item.descricao);
        console.log(`[autoMerge] Processando: "${item.descricao}"`);

        const existingRule = await mergeRules.findOne({ descricao_original_normalizada: descNorm });
        if (existingRule) {
          console.log(`[autoMerge] Já tem regra, pulando.`);
          continue;
        }

        const produtoAtual = await products.findOne({ nome_normalizado: descNorm });
        if (!produtoAtual) {
          console.log(`[autoMerge] Produto não encontrado.`);
          continue;
        }

        const allProducts = await products.find({
          _id: { $ne: produtoAtual._id },
          block_auto_merge: { $ne: true }
        }).toArray();

        if (allProducts.length === 0) {
          console.log(`[autoMerge] Nenhum outro produto.`);
          continue;
        }

        // 🔥 THRESHOLD BAIXO: 0.4 (seguro)
        const fuse = new Fuse(allProducts, {
          keys: ['nome_original', 'nome_normalizado'],
          threshold: 0.4,
          includeScore: true,
          ignoreLocation: true,
        });
        const candidatos = fuse.search(item.descricao)
          .filter(r => r.score <= 0.4)
          .map(r => r.item);

        console.log(`[autoMerge] ${candidatos.length} candidatos.`);

        if (candidatos.length === 0) continue;

        const listaParaCluster = [
          {
            descricao: produtoAtual.nome_original,
            descricao_normalizada: produtoAtual.nome_normalizado,
            _id: produtoAtual._id,
            vezes: mapContagem.get(String(produtoAtual._id)) || 0
          },
          ...candidatos.map(p => ({
            descricao: p.nome_original,
            descricao_normalizada: p.nome_normalizado,
            _id: p._id,
            vezes: mapContagem.get(String(p._id)) || 0
          }))
        ];

        // 🔥 CLUSTER THRESHOLD: 0.35 (rigoroso)
        const grupo = sugerirGrupoDuplicado(listaParaCluster, 0.35);
        if (!grupo) {
          console.log(`[autoMerge] Nenhum grupo formado.`);
          continue;
        }

        console.log(`[autoMerge] Grupo com ${grupo.itens.length} itens. Âncora: "${grupo.ancora.descricao}"`);

        // ─── VERIFICAÇÃO DE PALAVRAS‑CHAVE (segurança extra) ──────────────
        const palavrasAncora = grupo.ancora.descricao.toLowerCase().split(/\s+/);
        const todosCompartilham = grupo.itens.every(i => {
          const palavrasItem = i.descricao.toLowerCase().split(/\s+/);
          return palavrasAncora.some(p => palavrasItem.includes(p));
        });
        if (!todosCompartilham) {
          console.log(`[autoMerge] Grupo rejeitado: itens não compartilham palavras‑chave.`);
          continue;
        }

        const itemNoGrupo = grupo.itens.some(i => String(i._id) === String(produtoAtual._id));
        if (!itemNoGrupo) {
          console.log(`[autoMerge] Produto atual não está no grupo.`);
          continue;
        }

        const ancora = grupo.ancora;
        if (String(ancora._id) === String(produtoAtual._id)) {
          console.log(`[autoMerge] Âncora é o próprio item.`);
          continue;
        }

        for (const itemDoGrupo of grupo.itens) {
          if (String(itemDoGrupo._id) === String(ancora._id)) continue;
          const descOriginal = itemDoGrupo.descricao;
          const descNormItem = normalizeProductName(descOriginal);
          console.log(`[autoMerge] Mesclando "${descOriginal}" → "${ancora.descricao}"`);
          await criarRegraEMesclar(db, { descricao: descOriginal }, ancora, descNormItem);
          await products.updateOne(
            { _id: itemDoGrupo._id },
            { $set: { block_auto_merge: true } }
          );
        }
      } catch (err) {
        console.error(`[autoMerge] Erro:`, err.message);
      }
    }
  } catch (err) {
    console.error('[autoMerge] Erro geral:', err.message);
    throw err;
  }
}

// ─── SALVAR COMPRA ──────────────────────────────────────────────────────────
const savePurchase = async (url, resultado) => {
  try {
    console.log('[savePurchase] Iniciando...', { url });
    const db = await getDb();
    const purchases = db.collection('purchases');
    const mergeRules = db.collection('merge_rules');
    const products = db.collection('products');

    const existing = await purchases.findOne({ url });
    if (existing) {
      console.log('[savePurchase] Duplicata.');
      return { duplicate: true };
    }

    const itensOriginais = resultado.itens.map(item => ({ ...item }));

    const rules = await mergeRules.find({}).toArray();
    const rulesMap = new Map(rules.map(r => [r.descricao_original_normalizada, r]));

    const produtosExistentes = await products.find({ block_auto_merge: { $ne: true } }).toArray();
    console.log('[savePurchase] Produtos carregados:', produtosExistentes.length);

    const produtosPorNomeNorm = new Map(produtosExistentes.map(p => [p.nome_normalizado, p]));
    const produtosPorCodigo = new Map(
      produtosExistentes.filter(p => p.codigo).map(p => [p.codigo, p])
    );

    const fuse = new Fuse(produtosExistentes, {
      keys: ['nome_original', 'nome_normalizado'],
      includeScore: true,
      threshold: FUZZY_THRESHOLD,
      ignoreLocation: true,
    });

    let fuzzyMergedCount = 0;

    const itensEnriquecidos = await Promise.all(
      resultado.itens.map(async (item) => {
        const nomeNorm = normalizeProductName(item.descricao);
        const rule = rulesMap.get(nomeNorm);

        if (rule) {
          console.log(`[savePurchase] Regra: "${item.descricao}" → "${rule.nome_final}"`);
          return {
            ...item,
            descricao_original: item.descricao,
            descricao: rule.nome_final,
            descricao_normalizada: rule.nome_final_normalizado,
            product_id: rule.product_id,
          };
        }

        const codigoJaConhecido = item.codigo && produtosPorCodigo.has(item.codigo);
        const nomeExiste = produtosPorNomeNorm.has(nomeNorm);

        if (!codigoJaConhecido && !nomeExiste) {
          const achados = fuse.search(nomeNorm)
            .filter(r => r.score <= FUZZY_THRESHOLD)
            .sort((a, b) => a.score - b.score);

          if (achados.length > 0) {
            fuzzyMergedCount++;
            const produtoCanonico = achados[0].item;
            console.log(`[savePurchase] Fuzzy: "${item.descricao}" → "${produtoCanonico.nome_original}" (score: ${achados[0].score})`);
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
    console.log('[savePurchase] Nota salva.');

    try {
      await autoMergeNovosItens(db, itensOriginais);
    } catch (err) {
      console.error('[savePurchase] Erro no auto-merge:', err.message);
    }

    const autoMerged = itensEnriquecidos.filter(i => i.descricao_original).length;
    return { duplicate: false, auto_merged: autoMerged, fuzzy_merged: fuzzyMergedCount };
  } catch (error) {
    console.error('[savePurchase] Erro:', error.message, error.stack);
    throw error;
  }
};

// ─── FUNÇÕES DE PARSING (sem alterações) ────────────────────────────────────
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  console.log(`[${req.method} /api/consulta-qrcode] Requisição:`, { url });

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
      return res.status(502).json({ error: 'Falha ao obter a página.' });
    }

    const html = await response.text();
    const resultado = parseHtml(html);

    const saveResult = await savePurchase(url, resultado);
    if (saveResult?.duplicate) {
      return res.status(409).json({ error: 'Nota já registrada.', duplicate: true });
    }

    return res.json({
      ...resultado,
      auto_merged: saveResult?.auto_merged ?? 0,
      fuzzy_merged: saveResult?.fuzzy_merged ?? 0,
    });
  } catch (err) {
    console.error(`Erro:`, err.message);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}