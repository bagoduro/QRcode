import 'dotenv/config';
import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido. Use GET.' });
  }

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

      // Última compra (mais recente)
      const ultimaCompra = historico[0];

      // Menor preço encontrado entre os locais
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
