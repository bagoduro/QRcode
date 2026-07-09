// ─── SERVICE: Normalize ──────────────────────────────────────────────────────
// Funções puras de normalização de texto. Usadas por controllers e por outros
// services (fuzzyMerge, parseNota) para gerar chaves comparáveis de produtos.

export const normalizeText = (text = '') => text.replace(/\s+/g, ' ').trim();

export const normalizeProductName = (text = '') =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export function parseValorNum(valor) {
  if (!valor) return null;
  const limpo = String(valor)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3},)/g, '')
    .replace(',', '.');
  const n = parseFloat(limpo);
  return isNaN(n) ? null : n;
}

export function calcPrecoUnitario(valor_total, quantidade) {
  const vt = parseValorNum(valor_total);
  const qt = parseValorNum(String(quantidade).replace(',', '.'));
  if (!vt || !qt || qt === 0) return null;
  return Math.round((vt / qt) * 100) / 100;
}
