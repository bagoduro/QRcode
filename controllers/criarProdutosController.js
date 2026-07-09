import * as ProductModel from '../models/Product.js';
import * as PurchaseModel from '../models/Purchase.js';
import { normalizeProductName } from '../services/normalize.js';

// ─── CONTROLLER: CriarProdutos ───────────────────────────────────────────────
// Ferramenta de manutenção: reconstrói a coleção products a partir das
// compras já salvas, em lotes (skip/limit).

export default async function criarProdutosController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.MIGRATE_SECRET;
  if (!secret) return res.status(500).json({ error: 'MIGRATE_SECRET não definida.' });
  if (req.query.secret !== secret) return res.status(401).json({ error: 'Senha incorreta.' });

  const limit = parseInt(req.query.limit) || 0;
  const skip = parseInt(req.query.skip) || 0;

  try {
    const totalNotas = await PurchaseModel.countAll();
    const cursor = await PurchaseModel.findPage(skip, limit, { itens: 1 });

    let processados = 0;
    let produtosCriados = 0;
    let produtosExistentes = 0;
    let itensProcessados = 0;

    for await (const purchase of cursor) {
      const itens = purchase.itens || [];
      for (const item of itens) {
        itensProcessados++;
        const descricaoOriginal = item.descricao || item.descricao_original || '';
        if (!descricaoOriginal.trim()) continue;

        const nomeNorm = normalizeProductName(descricaoOriginal);
        const existente = await ProductModel.findByNormalizedName(nomeNorm);
        if (existente) {
          await ProductModel.touchUpdatedAt(existente._id);
          produtosExistentes++;
          continue;
        }

        await ProductModel.insertNew({ ...item, descricao: descricaoOriginal, block_auto_merge: false }, nomeNorm);
        produtosCriados++;
      }
      processados++;
    }

    const proximoSkip = skip + (limit > 0 ? limit : totalNotas);
    const maisNotas = limit > 0 && proximoSkip < totalNotas;

    return res.json({
      ok: true,
      mensagem: 'Produtos criados a partir das notas existentes.',
      estatisticas: {
        notas_processadas: processados,
        total_notas: totalNotas,
        itens_processados: itensProcessados,
        produtos_criados: produtosCriados,
        produtos_ja_existentes: produtosExistentes,
        skip_atual: skip,
        limit: limit || 'ilimitado',
        proximo_skip: maisNotas ? proximoSkip : null,
        mais_notas: maisNotas,
      },
      instrucao: maisNotas
        ? `Execute novamente com ?secret=SUA_SENHA&skip=${proximoSkip}&limit=${limit} para continuar.`
        : 'Todos os itens foram processados.',
    });
  } catch (err) {
    console.error('[criar-produtos] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
