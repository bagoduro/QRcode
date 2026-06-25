import { getDb } from '../db.js';
import { load } from 'cheerio';

// ─── Utilitários ─────────────────────────────────────────────────────────────
const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

const normalizeProductName = (text = '') => {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

function parseValorNum(valor) {
  if (!valor) return null;
  const limpo = String(valor)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3},)/g, '')
    .replace(',', '.');
  const n = parseFloat(limpo);
  return isNaN(n) ? null : n;
}

function calcPrecoUnitario(valor_total, quantidade) {
  const vt = parseValorNum(valor_total);
  const qt = parseValorNum(String(quantidade).replace(',', '.'));
  if (!vt || !qt || qt === 0) return null;
  return Math.round((vt / qt) * 100) / 100;
}

// ─── Parse do HTML ──────────────────────────────────────────────────────────
const parseHtml = (html) => {
  const $ = load(html);

  const itens = [];
  $('#myTable tr').each((_, row) => {
    const cols = $(row)
      .find('td')
      .toArray()
      .map((td) => normalizeText($(td).text()));
    if (cols.length >= 4) {
      const itemMatch = cols[0].match(/^(.*?)\s*\(Código:\s*([^\)]+)\)/i);
      itens.push({
        descricao: itemMatch ? normalizeText(itemMatch[1]) : cols[0],
        codigo: itemMatch ? normalizeText(itemMatch[2]) : null,
        quantidade: cols[1].replace(/.*?:\s*/, ''),
        unidade: cols[2].replace(/.*?:\s*/, ''),
        valor_total: cols[3].replace(/.*?:\s*/, ''),
        preco_unitario: calcPrecoUnitario(cols[3].replace(/.*?:\s*/, ''), cols[1].replace(/.*?:\s*/, '')),
      });
    }
  });

  return { itens };
};

// ─── Handler principal ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.MIGRATE_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'MIGRATE_SECRET não definida.' });
  }
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  // ─── Parâmetros de lote ──────────────────────────────────────────────────
  const limit = parseInt(req.query.limit) || 10; // padrão: 10
  const skip = parseInt(req.query.skip) || 0;    // padrão: começa do início

  try {
    const db = await getDb();
    const purchases = db.collection('purchases');

    // Busca todas as notas, com skip e limit
    const cursor = purchases.find({})
      .skip(skip)
      .limit(limit);

    const totalNotas = await purchases.countDocuments({}); // total geral

    let notasProcessadas = 0;
    let itensRestaurados = 0;

    for await (const purchase of cursor) {
      const url = purchase.url;
      if (!url) {
        console.warn(`[restaurar] Nota sem URL, pulando.`);
        continue;
      }

      console.log(`[restaurar] Processando nota: ${url}`);

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
        if (!response.ok) {
          console.error(`[restaurar] Falha ao buscar ${url}: ${response.status}`);
          continue;
        }

        const html = await response.text();
        const { itens: itensOriginais } = parseHtml(html);

        if (!itensOriginais || itensOriginais.length === 0) {
          console.warn(`[restaurar] Nenhum item encontrado para ${url}`);
          continue;
        }

        // Mapeia por código
        const mapPorCodigo = new Map();
        itensOriginais.forEach(item => {
          if (item.codigo) mapPorCodigo.set(item.codigo, item);
        });

        let modified = false;
        const itensAtualizados = purchase.itens.map((item, index) => {
          let original = null;
          if (item.codigo) {
            original = mapPorCodigo.get(item.codigo);
          }
          if (!original && index < itensOriginais.length) {
            original = itensOriginais[index];
          }

          if (original && original.descricao) {
            if (item.descricao !== original.descricao) {
              modified = true;
              const nomeOriginal = original.descricao;
              const nomeNormalizado = normalizeProductName(nomeOriginal);
              return {
                ...item,
                descricao: nomeOriginal,
                descricao_normalizada: nomeNormalizado,
                quantidade: original.quantidade || item.quantidade,
                unidade: original.unidade || item.unidade,
                valor_total: original.valor_total || item.valor_total,
                preco_unitario: original.preco_unitario || item.preco_unitario,
              };
            }
          }
          return item;
        });

        if (modified) {
          await purchases.updateOne(
            { _id: purchase._id },
            { $set: { itens: itensAtualizados } }
          );
          notasProcessadas++;
          const restaurados = itensAtualizados.filter((i, idx) => {
            const orig = itensOriginais[idx];
            return orig && i.descricao === orig.descricao;
          }).length;
          itensRestaurados += restaurados;
          console.log(`[restaurar] Nota ${url} corrigida (${restaurados} itens)`);
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
        limit: limit,
        total_notas: totalNotas,
        proximo_skip: maisNotas ? proximoSkip : null,
        mais_notas: maisNotas,
      },
      instrucao: maisNotas
        ? `Execute novamente com ?secret=SUA_SENHA&skip=${proximoSkip}&limit=${limit} para processar o próximo lote.`
        : 'Todas as notas foram processadas.'
    });
  } catch (err) {
    console.error('[restaurar-nomes] Erro geral:', err.message);
    return res.status(500).json({ error: err.message });
  }
}