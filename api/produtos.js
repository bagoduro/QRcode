import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { bloqueados } = req.query; // true ou false
  const filter = bloqueados === 'true' ? { block_auto_merge: true } : { block_auto_merge: false };

  try {
    const db = await getDb();
    const products = await db.collection('products')
      .find(filter)
      .project({ nome_original: 1, nome_normalizado: 1, block_auto_merge: 1 })
      .toArray();
    res.json({ total: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}