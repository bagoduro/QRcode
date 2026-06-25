import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const secret = process.env.MIGRATE_SECRET; // usa a mesma senha do migrate
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  try {
    const db = await getDb();
    const result = await db.collection('products').updateMany(
      { block_auto_merge: true },
      { $set: { block_auto_merge: false } }
    );
    res.json({
      ok: true,
      mensagem: `${result.modifiedCount} produtos desbloqueados.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}