import 'dotenv/config';
import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Método não permitido. Use GET ou DELETE.' });
  }

  // DELETE: excluir nota pelo campo url
  if (req.method === 'DELETE') {
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
      console.error('[DELETE /api/historico-compras] Erro:', err.message, err.stack);
      return res.status(500).json({ error: 'Erro interno', details: err.message });
    }
  }

  const { produto, codigo, recorrentes, min_compras } = req.query;

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
        // Match normalizado preferencialmente
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
            preco_unitario: '$itens.preco_unitario',
            descricao_original: '$itens.descricao_original',
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

      // Última compra (mais recente)
      const ultimaCompra = historico[0];

      // Menor preço por unidade (correto para quantidades diferentes)
      const menorPreco = historico.reduce((menor, atual) => {
        const vAtual = atual.preco_unitario ?? parseValor(atual.valor_total);
        const vMenor = menor.preco_unitario ?? parseValor(menor.valor_total);
        return vAtual < vMenor ? atual : menor;
      }, historico[0]);

      return res.json({
        produto: produto || codigo,
        ultima_compra: ultimaCompra,
        menor_preco: menorPreco,
        historico,
      });
    } else if (recorrentes === 'true') {
      // Caso 2: itens recorrentes (compras frequentes, ex: higiene pessoal e produtos de casa)
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
          const vAtual = atual.preco_unitario ?? parseValor(atual.valor_total);
          const vMenor = menor.preco_unitario ?? parseValor(menor.valor_total);
          return vAtual < vMenor ? atual : menor;
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
    console.error('[GET /api/historico-compras] Erro:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}

// Converte strings de valor monetário (ex: "R$ 12,50" ou "12,50") para número
function parseValor(valor) {
  if (!valor) return Infinity;
  const limpo = String(valor)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3},)/g, '')
    .replace(',', '.');
  const numero = parseFloat(limpo);
  return isNaN(numero) ? Infinity : numero;
}
