import * as ProductModel from '../models/Product.js';

// ─── CONTROLLER: Blacklist ───────────────────────────────────────────────────
// Endpoint legado (usado só no server.js local) que devolve a lista simples
// de nomes normalizados bloqueados. Mantido por compatibilidade.

export default async function blacklistController(req, res) {
  try {
    const blocked = await ProductModel.findByBlockedStatus(true);
    res.json({ itens: blocked.map((b) => b.nome_normalizado) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
