import { getDb } from '../models/db.js';

// ─── CONTROLLER: Health ──────────────────────────────────────────────────────

export default async function healthController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: 'ok', db: 'connected' });
  } catch (error) {
    console.error('[/api/health] Erro:', error.message);
    res.status(500).json({ status: 'error', db: 'disconnected', error: error.message });
  }
}
