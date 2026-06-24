import Fuse from 'fuse.js';

const DEFAULT_THRESHOLD = 0.4;

/**
 * Procura, dentro de uma lista de sugestões de produto (mesmo termo buscado),
 * o maior grupo de descrições que são variações/typos do mesmo produto.
 *
 * Usa o item mais comprado como "âncora" (presumivelmente o nome mais
 * confiável) e busca, via Fuse.js, quais outras descrições são similares
 * o suficiente pra serem o mesmo produto.
 *
 * Retorna null se não achar nenhum grupo com 2+ itens.
 */
export function sugerirGrupoDuplicado(lista, threshold = DEFAULT_THRESHOLD) {
  if (!lista || lista.length < 2) return null;

  const restante = [...lista];
  let melhorGrupo = null;

  while (restante.length >= 2) {
    restante.sort((a, b) => (b.vezes || 0) - (a.vezes || 0));
    const ancora = restante[0];

    const fuse = new Fuse(restante, {
      keys: ['descricao'],
      includeScore: true,
      threshold,
      ignoreLocation: true,
    });

    const achados = fuse
      .search(ancora.descricao)
      .filter((r) => r.score <= threshold)
      .map((r) => r.item);

    if (achados.length >= 2) {
      const grupo = { ancora, itens: achados };
      if (!melhorGrupo || grupo.itens.length > melhorGrupo.itens.length) {
        melhorGrupo = grupo;
      }
    }

    const descartar = new Set([ancora.descricao, ...achados.map((i) => i.descricao)]);
    for (let i = restante.length - 1; i >= 0; i--) {
      if (descartar.has(restante[i].descricao)) restante.splice(i, 1);
    }
  }

  return melhorGrupo;
}
