import * as PurchaseModel from '../models/Purchase.js';
import { parseItensFromHtml } from '../services/parseNota.js';
import { normalizeProductName } from '../services/normalize.js';

// ─── CONTROLLER: RestaurarNomes ──────────────────────────────────────────────
// Ferramenta de manutenção: rebusca a página original da SEFAZ para corrigir
// nomes de itens que foram mal interpretados na primeira leitura.

export default async function restaurarNomesController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.MIGRATE_SECRET;
  if (!secret) return res.status(500).json({ error: 'MIGRATE_SECRET não definida.' });
  if (req.query.secret !== secret) return res.status(401).json({ error: 'Senha incorreta.' });

  const limit = parseInt(req.query.limit) || 10;
  const skip = parseInt(req.query.skip) || 0;

  try {
    const totalNotas = await PurchaseModel.countAll();
    const cursor = await PurchaseModel.findPage(skip, limit);

    let notasProcessadas = 0;
    let itensRestaurados = 0;

    for await (const purchase of cursor) {
      const url = purchase.url;
      if (!url) continue;

      try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        if (!response.ok) continue;

        const html = await response.text();
        const { itens: itensOriginais } = parseItensFromHtml(html);
        if (!itensOriginais || itensOriginais.length === 0) continue;

        const mapPorCodigo = new Map();
        itensOriginais.forEach((item) => {
          if (item.codigo) mapPorCodigo.set(item.codigo, item);
        });

        let modified = false;
        const itensAtualizados = purchase.itens.map((item, index) => {
          let original = null;
          if (item.codigo) original = mapPorCodigo.get(item.codigo);
          if (!original && index < itensOriginais.length) original = itensOriginais[index];

          if (original && original.descricao && item.descricao !== original.descricao) {
            modified = true;
            const nomeNormalizado = normalizeProductName(original.descricao);
            return {
              ...item,
              descricao: original.descricao,
              descricao_normalizada: nomeNormalizado,
              quantidade: original.quantidade || item.quantidade,
              unidade: original.unidade || item.unidade,
              valor_total: original.valor_total || item.valor_total,
              preco_unitario: original.preco_unitario || item.preco_unitario,
            };
          }
          return item;
        });

        if (modified) {
          await PurchaseModel.updateItensById(purchase._id, itensAtualizados);
          notasProcessadas++;
          const restaurados = itensAtualizados.filter((i, idx) => {
            const orig = itensOriginais[idx];
            return orig && i.descricao === orig.descricao;
          }).length;
          itensRestaurados += restaurados;
        }
      } catch (err) {
        console.error(`[restaurar] Erro ao processar ${url}:`, err.message);
      }
    }

    const proximoSkip = skip + limit;
    const maisNotas = proximoSkip < totalNotas;

    return res.json({
      ok: true,
      mensagem: 'Restauração concluída para este lote.',
      lote: {
        processadas: notasProcessadas,
        itens_restaurados: itensRestaurados,
        skip_atual: skip,
        limit,
        total_notas: totalNotas,
        proximo_skip: maisNotas ? proximoSkip : null,
        mais_notas: maisNotas,
      },
      instrucao: maisNotas
        ? `Execute novamente com ?secret=SUA_SENHA&skip=${proximoSkip}&limit=${limit} para processar o próximo lote.`
        : 'Todas as notas foram processadas.',
    });
  } catch (err) {
    console.error('[restaurar-nomes] Erro geral:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
