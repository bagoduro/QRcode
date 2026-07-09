import * as ProductModel from '../models/Product.js';

// ─── CONTROLLER: Produtos ────────────────────────────────────────────────────

export default async function produtosController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { bloqueados } = req.query;
  const blocked = bloqueados === 'true';

  try {
    const products = await ProductModel.findByBlockedStatus(blocked);
    res.json({ total: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
