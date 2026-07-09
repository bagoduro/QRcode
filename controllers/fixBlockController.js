import * as ProductModel from '../models/Product.js';
import * as MergeRuleModel from '../models/MergeRule.js';

// ─── CONTROLLER: FixBlock ────────────────────────────────────────────────────

export default async function fixBlockController(req, res) {
  const secret = process.env.MIGRATE_SECRET;
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  try {
    const destinos = await MergeRuleModel.distinctFinalNormalized();
    const origens = await MergeRuleModel.distinctOriginalNormalized();

    const resultDestinos = await ProductModel.blockManyByNormalizedNames(destinos);
    const resultOrigens = await ProductModel.blockManyByNormalizedNames(origens);

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
