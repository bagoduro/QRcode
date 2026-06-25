import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Usa a MESMA variável de ambiente do /api/migrate
  const secret = process.env.MIGRATE_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'MIGRATE_SECRET não definida no servidor.' });
  }
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta. Use ?secret=SUA_SENHA' });
  }

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');
    const products = db.collection('products');

    // Busca todas as notas que têm itens com descricao = null ou descricao_normalizada = null
    const cursor = purchases.find({
      $or: [
        { 'itens.descricao': null },
        { 'itens.descricao_normalizada': null }
      ]
    });

    let totalItensRestaurados = 0;
    let totalNotas = 0;

    for await (const purchase of cursor) {
      let modified = false;
      const itensAtualizados = await Promise.all(
        purchase.itens.map(async (item) => {
          // Se descricao for null, tenta restaurar
          if (item.descricao === null || item.descricao === undefined || item.descricao === '') {
            // 1. Tenta usar descricao_original se existir
            if (item.descricao_original && item.descricao_original.trim() !== '') {
              modified = true;
              const nomeOriginal = item.descricao_original;
              const nomeNormalizado = nomeOriginal
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .trim();
              return {
                ...item,
                descricao: nomeOriginal,
                descricao_normalizada: nomeNormalizado
              };
            }
            // 2. Se não tem descricao_original, tenta buscar pelo product_id
            if (item.product_id) {
              const produto = await products.findOne({ _id: item.product_id });
              if (produto && produto.nome_original) {
                modified = true;
                return {
                  ...item,
                  descricao: produto.nome_original,
                  descricao_normalizada: produto.nome_normalizado
                };
              }
            }
          }
          // Se descricao_normalizada for null mas descricao existir, corrige
          if (item.descricao && item.descricao.trim() !== '' && !item.descricao_normalizada) {
            modified = true;
            const nomeNormalizado = item.descricao
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .trim();
            return {
              ...item,
              descricao_normalizada: nomeNormalizado
            };
          }
          return item;
        })
      );

      if (modified) {
        await purchases.updateOne(
          { _id: purchase._id },
          { $set: { itens: itensAtualizados } }
        );
        totalNotas++;
        const restaurados = itensAtualizados.filter(i => i.descricao && i.descricao !== null).length;
        totalItensRestaurados += restaurados;
      }
    }

    return res.json({
      ok: true,
      mensagem: 'Restauração concluída.',
      notas_afetadas: totalNotas,
      itens_restaurados: totalItensRestaurados
    });

  } catch (err) {
    console.error('[restaurar-nomes] Erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
}