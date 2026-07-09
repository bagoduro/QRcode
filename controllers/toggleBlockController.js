import * as ProductModel from '../models/Product.js';

// ─── CONTROLLER: ToggleBlock ─────────────────────────────────────────────────

export default async function toggleBlockController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const { nome_normalizado, blocked } = req.body;
  if (!nome_normalizado) {
    return res.status(400).json({ error: 'Faltando "nome_normalizado"' });
  }

  try {
    const result = await ProductModel.setBlockedByNormalizedName(nome_normalizado, blocked === true);
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    res.json({ ok: true, blocked: blocked === true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
