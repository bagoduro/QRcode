import 'dotenv/config';
import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Método não permitido. Use GET ou DELETE.' });
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Parâmetro "url" é obrigatório.' });
    try {
      const db = await getDb();
      const result = await db.collection('purchases').deleteOne({ url });
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Nota não encontrada.' });
      return res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /api/historico-compras] Erro:', err.message);
      return res.status(500).json({ error: 'Erro interno', details: err.message });
    }
  }

  const { produto, codigo, recorrentes, min_compras, sugestoes, comparar } = req.query;

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const products = db.collection('products');

    // ─── SUGESTÕES ────────────────────────────────────────────────────────────
    if (sugestoes === 'true' && produto) {
      const termoNorm = produto
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

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
            menor_preco_unitario: { $min: { $ifNull: ['$itens.preco_unitario', null] } },
            ultimo_valor: { $last: '$itens.valor_total' },
            ultimo_local: { $last: '$emitente.nome' },
          },
        },
        { $sort: { vezes: -1 } },
        { $limit: 10 },
      ];

      const sugestoesList = await purchases.aggregate(pipeline).toArray();

      // Buscar bloqueio para cada sugestão
      const normas = sugestoesList.map(s => s._id);
      const produtosDocs = await products.find({ nome_normalizado: { $in: normas } }).toArray();
      const blockedMap = new Map(produtosDocs.map(p => [p.nome_normalizado, p.block_auto_merge === true]));

      const sugestoesComBloqueio = sugestoesList.map(s => ({
        descricao: s.descricao_original,
        descricao_normalizada: s._id,
        codigo: s.codigo,
        vezes: s.vezes,
        menor_preco_unitario: s.menor_preco_unitario,
        ultimo_valor: s.ultimo_valor,
        ultimo_local: s.ultimo_local,
        blocked: blockedMap.get(s._id) || false,
      }));

      return res.json({
        termo: produto,
        total: sugestoesComBloqueio.length,
        sugestoes: sugestoesComBloqueio,
      });
    }

    // ─── COMPARAÇÃO ──────────────────────────────────────────────────────────
    if (comparar && (produto || codigo)) {
      const matchStage = {};
      if (codigo) {
        matchStage['itens.codigo'] = codigo;
      } else {
        const prodNorm = produto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        matchStage['itens.descricao_normalizada'] = { $regex: prodNorm, $options: 'i' };
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
                preco_unitario: '$itens.preco_unitario',
                unidade: '$itens.unidade',
              },
            },
          },
        },
        { $sort: { vezes_comprado: -1, ultima_data: -1 } },
      ];

      const lojas = await purchases.aggregate(pipeline).toArray();

      const lojasEnriquecidas = lojas.map((loja) => {
        const ocorrencias = [...loja.ocorrencias].sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
        const menorOcorrencia = loja.ocorrencias.reduce((menor, atual) => {
          const vAtual = atual.preco_unitario ?? parseValor(atual.valor_total);
          const vMenor = menor.preco_unitario ?? parseValor(menor.valor_total);
          return vAtual < vMenor ? atual : menor;
        }, loja.ocorrencias[0]);

        return {
          local: loja.local,
          cnpj: loja.cnpj,
          uf: loja.uf,
          vezes_comprado: loja.vezes_comprado,
          ultimo_valor: ocorrencias[0]?.valor_total,
          ultimo_preco_unitario: ocorrencias[0]?.preco_unitario ?? null,
          ultima_data: ocorrencias[0]?.data_compra,
          menor_valor: menorOcorrencia?.valor_total,
          menor_preco_unitario: menorOcorrencia?.preco_unitario ?? null,
          unidade: menorOcorrencia?.unidade ?? null,
          ocorrencias,
        };
      });

      const lojasOrdenadas = [...lojasEnriquecidas].sort(
        (a, b) => parseValor(a.menor_valor) - parseValor(b.menor_valor)
      );

      return res.json({
        produto: produto || codigo,
        total_lojas: lojasOrdenadas.length,
        lojas: lojasOrdenadas,
      });
    }

    // ─── HISTÓRICO DE UM PRODUTO ────────────────────────────────────────────
    if (produto || codigo) {
      const matchStage = {};
      if (codigo) {
        matchStage['itens.codigo'] = codigo;
      } else {
        const prodNorm = produto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        matchStage['$or'] = [
          { 'itens.descricao_normalizada': { $regex: prodNorm, $options: 'i' } },
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
            preco_unitario: '$itens.preco_unitario',
            descricao_original: '$itens.descricao_original',
          },
        },
        { $sort: { createdAt: -1 } },
      ];

      const historico = await purchases.aggregate(pipeline).toArray();
      if (historico.length === 0) {
        return res.json({ produto: produto || codigo, ultima_compra: null, menor_preco: null, historico: [] });
      }

      const ultimaCompra = historico[0];
      const menorPreco = historico.reduce((menor, atual) => {
        const vAtual = atual.preco_unitario ?? parseValor(atual.valor_total);
        const vMenor = menor.preco_unitario ?? parseValor(menor.valor_total);
        return vAtual < vMenor ? atual : menor;
      }, historico[0]);

      // Verificar bloqueio
      const nomeProdNorm = (produto || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const prodDoc = await products.findOne({ nome_normalizado: nomeProdNorm });
      const blocked = prodDoc?.block_auto_merge === true;

      const mergeRules = db.collection('merge_rules');
      const regraAtiva = nomeProdNorm ? await mergeRules.findOne({ nome_final_normalizado: nomeProdNorm }) : null;

      return res.json({
        produto: produto || codigo,
        ultima_compra: ultimaCompra,
        menor_preco: menorPreco,
        historico,
        mesclado: !!regraAtiva,
        blocked,
      });
    }

    // ─── RECORRENTES ──────────────────────────────────────────────────────────
    if (recorrentes === 'true') {
      const minCompras = parseInt(min_compras, 10) || 2;
      const pipeline = [
        { $unwind: '$itens' },
        {
          $group: {
            _id: { codigo: '$itens.codigo', descricao: '$itens.descricao' },
            descricao: { $last: '$itens.descricao' },
            descricao_normalizada: { $last: '$itens.descricao_normalizada' },
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
                preco_unitario: '$itens.preco_unitario',
              },
            },
          },
        },
        { $match: { vezes_comprado: { $gte: minCompras } } },
        { $sort: { vezes_comprado: -1, ultima_data: -1 } },
      ];

      const grupos = await purchases.aggregate(pipeline).toArray();

      const normas = grupos.map(g => g.descricao_normalizada).filter(Boolean);
      const produtosDocs = await products.find({ nome_normalizado: { $in: normas } }).toArray();
      const blockedMap = new Map(produtosDocs.map(p => [p.nome_normalizado, p.block_auto_merge === true]));

      const itensRecorrentes = grupos.map((grupo) => {
        const ocorrenciasOrdenadas = [...grupo.ocorrencias].sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
        const menorPreco = grupo.ocorrencias.reduce((menor, atual) => {
          const vAtual = atual.preco_unitario ?? parseValor(atual.valor_total);
          const vMenor = menor.preco_unitario ?? parseValor(menor.valor_total);
          return vAtual < vMenor ? atual : menor;
        }, grupo.ocorrencias[0]);

        return {
          descricao: grupo.descricao,
          descricao_normalizada: grupo.descricao_normalizada,
          codigo: grupo.codigo,
          vezes_comprado: grupo.vezes_comprado,
          ultima_compra: ocorrenciasOrdenadas[0],
          menor_preco: menorPreco,
          blocked: blockedMap.get(grupo.descricao_normalizada) || false,
        };
      });

      return res.json({
        criterio_minimo_compras: minCompras,
        total: itensRecorrentes.length,
        itens_recorrentes: itensRecorrentes,
      });
    }

    // ─── LISTA GERAL ──────────────────────────────────────────────────────────
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
    console.error('[GET /api/historico-compras] Erro:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}

function parseValor(valor) {
  if (!valor) return Infinity;
  const limpo = String(valor).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3},)/g, '').replace(',', '.');
  const numero = parseFloat(limpo);
  return isNaN(numero) ? Infinity : numero;
}