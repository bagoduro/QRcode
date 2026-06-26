import { getDb } from '../db.js';

// ─── Utilitário de normalização (igual ao usado nas consultas) ─────────────
function normalizeProductName(text = '') {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Handler principal ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Proteção por senha (mesma usada no migrate)
  const secret = process.env.MIGRATE_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'MIGRATE_SECRET não definida.' });
  }
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  // Parâmetros de lote (opcionais)
  const limit = parseInt(req.query.limit) || 0;   // 0 = sem limite
  const skip  = parseInt(req.query.skip)  || 0;

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const products  = db.collection('products');

    // Busca todas as notas com paginação
    let cursor = purchases.find({}, { projection: { itens: 1 } });
    if (limit > 0) cursor = cursor.skip(skip).limit(limit);
    const totalNotas = await purchases.countDocuments({});

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
        // Verifica se o produto já existe
        const existente = await products.findOne({ nome_normalizado: nomeNorm });
        if (existente) {
          // Atualiza a data de modificação (opcional)
          await products.updateOne(
            { _id: existente._id },
            { $set: { updatedAt: new Date() } }
          );
          produtosExistentes++;
          continue;
        }

        // Cria novo produto
        const novoProduto = {
          createdAt: new Date(),
          codigo: item.codigo || null,
          nome_original: descricaoOriginal,
          nome_normalizado: nomeNorm,
          updatedAt: new Date(),
          block_auto_merge: false, // inicialmente desbloqueado
        };
        await products.insertOne(novoProduto);
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
        : 'Todos os itens foram processados.'
    });

  } catch (err) {
    console.error('[criar-produtos] Erro:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}