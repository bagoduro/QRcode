import 'dotenv/config';
import { getDb } from '../db.js'; // caminho relativo

export default async function handler(req, res) {
  // Proteger com senha
  const secret = process.env.MIGRATE_SECRET;
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  try {
    const db = await getDb();
    const products = db.collection('products');
    const mergeRules = db.collection('merge_rules');

    const destinos = await mergeRules.distinct('nome_final_normalizado');
    const origens = await mergeRules.distinct('descricao_original_normalizada');

    const resultDestinos = await products.updateMany(
      { nome_normalizado: { $in: destinos } },
      { $set: { block_auto_merge: true, updatedAt: new Date() } }
    );
    const resultOrigens = await products.updateMany(
      { nome_normalizado: { $in: origens } },
      { $set: { block_auto_merge: true, updatedAt: new Date() } }
    );

    return res.json({
      ok: true,
      destinos_atualizados: resultDestinos.modifiedCount,
      origens_atualizadas: resultOrigens.modifiedCount,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}