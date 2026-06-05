import 'dotenv/config';
import { getDb } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    console.log('[/api/health] MongoDB conectado');
    res.json({ status: 'ok', db: 'connected' });
  } catch (error) {
    console.error('[/api/health] Erro:', error.message);
    res.status(500).json({ status: 'error', db: 'disconnected', error: error.message });
  }
}
