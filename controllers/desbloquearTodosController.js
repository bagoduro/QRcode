import * as ProductModel from '../models/Product.js';

// ─── CONTROLLER: DesbloquearTodos ────────────────────────────────────────────

export default async function desbloquearTodosController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.MIGRATE_SECRET;
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  try {
    const result = await ProductModel.unblockAll();
    res.json({ ok: true, mensagem: `${result.modifiedCount} produtos desbloqueados.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
