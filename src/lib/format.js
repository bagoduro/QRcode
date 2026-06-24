export function formatValor(valor) {
  if (!valor && valor !== 0) return '-';
  const match = String(valor).match(/[\d.,]+/);
  if (!match) return valor;
  return 'R$ ' + match[0].replace('.', ',').replace(/^,/, '0,');
}

export function formatPrecoUnitario(precoUnitario, unidade) {
  if (!precoUnitario && precoUnitario !== 0) return null;
  const u = unidade ? '/' + unidade.toLowerCase() : '/un';
  return formatValor(precoUnitario) + u;
}

export function formatData(data) {
  if (!data) return '-';
  return String(data).split(' ')[0];
}
