import { useEffect, useState } from 'react';
import { Loading, EmptyState, Alert } from '../components/Feedback';
import PriceChart from '../components/PriceChart';
import { apiGet, apiPost } from '../lib/api';
import { formatValor, formatPrecoUnitario, formatData } from '../lib/format';
import { sugerirGrupoDuplicado } from '../lib/fuzzyMerge';

const MAX_AUTO_MERGE_PASSES = 4;

export default function BuscarTab({ isLoggedIn, jumpToProduct, onJumpConsumed }) {
  const [query, setQuery] = useState('');
  const [termoBuscado, setTermoBuscado] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sugestoes, setSugestoes] = useState(null); // { lista, termo }
  const [detalhe, setDetalhe] = useState(null); // { data, dataComp, termo }
  const [mensagem, setMensagem] = useState(null); // { tone, text }
  const [autoMesclando, setAutoMesclando] = useState(false);

  useEffect(() => {
    if (!jumpToProduct) return;
    setQuery(jumpToProduct);
    setTermoBuscado(jumpToProduct);
    mostrarHistoricoProduto(jumpToProduct);
    onJumpConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToProduct]);

  function resetResultViews() {
    setError(null);
    setSugestoes(null);
    setDetalhe(null);
    setMensagem(null);
  }

  //  autoMesclar agora recebe a blacklist e ignora grupos bloqueados
  async function autoMesclar(lista, blacklist = []) {
    let atual = lista;
    let alguemFoiMesclado = false;

    for (let tentativa = 0; tentativa < MAX_AUTO_MERGE_PASSES; tentativa++) {
      const grupo = sugerirGrupoDuplicado(atual, 0.35);
      if (!grupo) break;

      //  Verifica se algum item do grupo está na blacklist
      const grupoNorms = grupo.itens.map(i => i.descricao_normalizada);
      if (grupoNorms.some(n => blacklist.includes(n))) {
        // Remove esses itens da lista atual para não ficar em loop infinito
        const descartar = new Set(grupo.itens.map(i => i.descricao));
        atual = atual.filter(i => !descartar.has(i.descricao));
        continue; // pula este grupo
      }

      try {
        await apiPost('/mesclar-produtos', {
          descricoes: grupo.itens.map((i) => i.descricao),
          nome_final: grupo.ancora.descricao,
        });
        alguemFoiMesclado = true;
      } catch {
        break;
      }

      // Remove apenas os itens duplicados, mantendo o âncora
      const descartar = new Set(grupo.itens.map((i) => i.descricao));
      descartar.delete(grupo.ancora.descricao);
      atual = atual.filter((i) => !descartar.has(i.descricao));
    }

    return { lista: atual, alguemFoiMesclado };
  }

  async function buscarPorTermo(termo) {
    if (!termo) return;
    setTermoBuscado(termo);
    resetResultViews();
    setLoading(true);
    setAutoMesclando(false);
    try {
      //  Carrega a blacklist antes de iniciar o auto‑merge
      let blacklist = [];
      try {
        const blacklistData = await apiGet('/auto-merge-blacklist');
        blacklist = blacklistData?.itens || [];
      } catch (e) {
        // Se falhar, apenas não bloqueia nada
        console.warn('Não foi possível carregar a blacklist', e);
      }

      const data = await apiGet('/historico-compras', { produto: termo, sugestoes: 'true' });
      if (!data.sugestoes || data.sugestoes.length === 0) {
        setMensagem({ tone: 'empty', text: 'Nenhuma compra encontrada para esse produto.' });
        return;
      }
      if (data.sugestoes.length === 1) {
        await mostrarHistoricoProduto(data.sugestoes[0].descricao);
        return;
      }

      let lista = data.sugestoes;

      setAutoMesclando(true);
      //  Passa a blacklist para o autoMesclar
      const { lista: listaMesclada, alguemFoiMesclado } = await autoMesclar(lista, blacklist);
      setAutoMesclando(false);

      if (alguemFoiMesclado) {
        setMensagem({
          tone: 'success',
          text: 'Alguns produtos foram mesclados automaticamente.',
        });
        setTimeout(() => setMensagem(null), 4000);
      }

      setSugestoes({ lista: listaMesclada, termo });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setAutoMesclando(false);
    }
  }

  async function mostrarHistoricoProduto(termoProduto) {
    resetResultViews();
    setLoading(true);
    try {
      const [data, dataComp] = await Promise.all([
        apiGet('/historico-compras', { produto: termoProduto }),
        apiGet('/historico-compras', { produto: termoProduto, comparar: 'true' }),
      ]);
      if (!data.historico || data.historico.length === 0) {
        setMensagem({ tone: 'empty', text: 'Nenhuma compra encontrada.' });
        return;
      }
      setDetalhe({ data, dataComp, termo: termoProduto });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit() {
    const termo = query.trim();
    if (!termo) return;
    buscarPorTermo(termo);
  }

  function handleVoltar() {
    if (termoBuscado) buscarPorTermo(termoBuscado);
    else resetResultViews();
  }

  return (
    <section className="panel active">
      <div className="card">
        <h2>Buscar produto</h2>
        <div className="field">
          <label htmlFor="input-produto">Nome do produto</label>
          <div className="input-row">
            <input
              type="text"
              id="input-produto"
              placeholder="ex: arroz, sabonete, papel higiênico"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
            />
            <button className="btn primary" onClick={handleSubmit}>
              <i className="ti ti-search" aria-hidden="true" />
            </button>
          </div>
          <p className="helper">Busca por aproximação no nome do item registrado nas notas.</p>
        </div>

        <div className="result-area">
          {loading && (
            <Loading
              text={
                autoMesclando
                  ? 'Verificando duplicados e mesclando automaticamente...'
                  : detalhe === null && sugestoes === null
                  ? 'Buscando...'
                  : 'Carregando histórico...'
              }
            />
          )}
          {!loading && error && <Alert tone="danger">{error}</Alert>}
          {!loading && mensagem?.tone === 'empty' && <EmptyState icon="ti-package-off" text={mensagem.text} />}
          {!loading && sugestoes && (
            <Sugestoes
              lista={sugestoes.lista}
              termo={sugestoes.termo}
              isLoggedIn={isLoggedIn}
              onEscolher={(descricao) => mostrarHistoricoProduto(descricao)}
              onConcluido={() => buscarPorTermo(sugestoes.termo)}
              setMensagem={setMensagem}
              setError={setError}
            />
          )}
          {!loading && detalhe && (
            <Detalhe
              data={detalhe.data}
              dataComp={detalhe.dataComp}
              termo={detalhe.termo}
              isLoggedIn={isLoggedIn}
              onVoltar={handleVoltar}
              onRecarregar={() => mostrarHistoricoProduto(detalhe.termo)}
            />
          )}
          {!loading && mensagem?.tone === 'success' && (
            <>
              <Alert tone="success">{mensagem.text}</Alert>
              <button className="btn-voltar-busca" onClick={handleVoltar}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> Voltar para resultados
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Sugestoes({ lista, termo, isLoggedIn, onEscolher, onConcluido, setMensagem, setError }) {
  const [modoMesclar, setModoMesclar] = useState(false);
  const [selecionados, setSelecionados] = useState(new Set());
  const [nomeFinal, setNomeFinal] = useState('');
  const [mesclando, setMesclando] = useState(false);
  const [desfazendo, setDesfazendo] = useState(false);

  const podeDesfazer = lista.length === 1 && lista[0].mesclado === true && isLoggedIn;

  function toggleSelecionado(descricao) {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(descricao)) next.delete(descricao);
      else next.add(descricao);
      if (next.size === 1 && !nomeFinal.trim()) {
        setNomeFinal([...next][0]);
      }
      return next;
    });
  }

  function cancelarMesclagem() {
    setModoMesclar(false);
    setSelecionados(new Set());
    setNomeFinal('');
  }

  async function confirmarMesclagem() {
    const descricoes = [...selecionados];
    const nome = nomeFinal.trim();
    if (descricoes.length < 2 || !nome) return;
    setMesclando(true);
    try {
      const data = await apiPost('/mesclar-produtos', { descricoes, nome_final: nome });
      setMensagem({
        tone: 'success',
        text: `"${data.nome_final}" criado — ${data.produtos_mesclados} produtos mesclados em ${data.notas_atualizadas} nota(s).`,
      });
      setTimeout(() => onConcluido?.(), 900);
    } catch (err) {
      setError(err.message);
      setMesclando(false);
    }
  }

  async function desfazerMesclagem() {
    setDesfazendo(true);
    try {
      const data = await apiPost('/mesclar-produtos', { action: 'unmerge', descricao_mesclada: lista[0].descricao });
      setMensagem({ tone: 'success', text: `Mesclagem de "${termo}" desfeita. ${data.itens_restaurados} itens restaurados.` });
      setTimeout(() => onConcluido?.(), 900);
    } catch (err) {
      setError('Não foi possível desfazer: ' + err.message);
      setDesfazendo(false);
    }
  }

  const ok = selecionados.size >= 2 && nomeFinal.trim() !== '';

  return (
    <div>
      <div className="sugestoes-toolbar">
        <div>
          <p className="sugestao-titulo">
            Encontrei <strong>{lista.length}</strong> produto{lista.length !== 1 ? 's' : ''} com &ldquo;<strong>{termo}</strong>&rdquo;. Qual você quer ver?
          </p>
          {isLoggedIn && (
            <p className="helper sugestao-auto-hint">
              <i className="ti ti-sparkles" aria-hidden="true" /> Duplicados parecidos já são mesclados automaticamente. Se sobrou algum, mescle manualmente abaixo.
            </p>
          )}
        </div>
        <div className="sugestoes-toolbar-actions">
          {podeDesfazer && (
            <button className="btn-modo-mesclar" disabled={desfazendo} onClick={desfazerMesclagem}>
              <i className={`ti ${desfazendo ? 'ti-loader-2 spin' : 'ti-git-pull-request'}`} aria-hidden="true" />
              {desfazendo ? 'Desfazendo...' : 'Desfazer'}
            </button>
          )}
          {isLoggedIn && (
            <button
              className={`btn-modo-mesclar ${modoMesclar ? 'ativo' : ''}`}
              onClick={() => (modoMesclar ? cancelarMesclagem() : setModoMesclar(true))}
            >
              <i className={`ti ${modoMesclar ? 'ti-x' : 'ti-git-merge'}`} aria-hidden="true" />
              {modoMesclar ? 'Cancelar' : 'Mesclar'}
            </button>
          )}
        </div>
      </div>

      <div className={`sugestao-lista ${modoMesclar ? 'modo-mesclar' : ''}`}>
        {lista.map((s) => (
          <div
            key={s.descricao}
            className={`sugestao-item ${selecionados.has(s.descricao) ? 'selecionado' : ''}`}
            onClick={() => (modoMesclar ? toggleSelecionado(s.descricao) : onEscolher(s.descricao))}
          >
            <div className="sug-check"><i className="ti ti-check" aria-hidden="true" /></div>
            <div className="sug-info">
              <p className="sug-nome">{s.descricao}</p>
              <p className="sug-meta">{s.vezes} compra{s.vezes !== 1 ? 's' : ''} registrada{s.vezes !== 1 ? 's' : ''}</p>
            </div>
            <div className="sug-preco">
              {s.menor_preco_unitario ? formatPrecoUnitario(s.menor_preco_unitario) : formatValor(s.ultimo_valor)}
            </div>
          </div>
        ))}
      </div>

      {modoMesclar && (
        <div className="mesclar-toolbar ativa">
          <label htmlFor="input-nome-final">Nome final do produto mesclado:</label>
          <input
            id="input-nome-final"
            type="text"
            placeholder="ex: LEITE CAMPONESA 1L INTEGRAL"
            value={nomeFinal}
            onChange={(e) => setNomeFinal(e.target.value)}
          />
          <div className="mesclar-acoes">
            <button className="btn-mesclar-cancelar" onClick={cancelarMesclagem}>Cancelar</button>
            <button className="btn-mesclar-confirmar" disabled={!ok || mesclando} onClick={confirmarMesclagem}>
              <i className="ti ti-git-merge" aria-hidden="true" />
              <span>
                {mesclando ? 'Mesclando...' : selecionados.size < 2 ? `Selecione ${2 - selecionados.size} mais` : `Mesclar ${selecionados.size} produtos`}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Detalhe({ data, dataComp, termo, isLoggedIn, onVoltar, onRecarregar }) {
  const [desfazendo, setDesfazendo] = useState(false);
  const [erroDesfazer, setErroDesfazer] = useState(null);

  const ultima = data.ultima_compra;
  const menor = data.menor_preco;
  const mesmaCompra =
    ultima.local === menor.local &&
    (ultima.preco_unitario ?? ultima.valor_total) === (menor.preco_unitario ?? menor.valor_total);

  const mostrarDesfazer = data.mesclado === true && isLoggedIn;

  async function desfazer() {
    setDesfazendo(true);
    setErroDesfazer(null);
    try {
      await apiPost('/mesclar-produtos', { action: 'unmerge', descricao_mesclada: termo });
      onRecarregar();
    } catch (err) {
      setErroDesfazer(err.message);
    } finally {
      setDesfazendo(false);
    }
  }

  return (
    <div>
      <div className="detalhe-toolbar">
        <button className="btn-voltar-busca" onClick={onVoltar}>
          <i className="ti ti-arrow-left" aria-hidden="true" /> Voltar
        </button>
        {mostrarDesfazer && (
          <button className="btn-modo-mesclar" disabled={desfazendo} onClick={desfazer} title="Desfazer mesclagem deste produto">
            <i className={`ti ${desfazendo ? 'ti-loader-2 spin' : 'ti-git-pull-request'}`} aria-hidden="true" />
            {desfazendo ? 'Desfazendo...' : 'Desfazer Mesclagem'}
          </button>
        )}
      </div>

      {erroDesfazer && <Alert tone="danger">{erroDesfazer}</Alert>}

      <div className="summary-grid">
        <div className="metric">
          <p className="label"><i className="ti ti-clock" aria-hidden="true" />Última compra</p>
          <p className="value">{formatValor(ultima.valor_total)}</p>
          {ultima.preco_unitario != null && (
            <p className="metric-sub">{formatPrecoUnitario(ultima.preco_unitario, ultima.unidade)}</p>
          )}
          <span className="badge last">{ultima.local}</span>
        </div>
        <div className="metric">
          <p className="label"><i className="ti ti-tag" aria-hidden="true" />Melhor preço/un</p>
          <p className="value">{formatValor(menor.valor_total)}</p>
          {menor.preco_unitario != null && (
            <p className="metric-sub">{formatPrecoUnitario(menor.preco_unitario, menor.unidade)}</p>
          )}
          <span className="badge best">{mesmaCompra ? 'Mesmo local' : menor.local}</span>
        </div>
      </div>

      <Comparacao data={dataComp} />

      <h2 className="section-title">Histórico de preços — {data.produto}</h2>
      <PriceChart historico={data.historico} />
      <div className="item-list">
        {data.historico.map((h, idx) => (
          <div className="result-row" key={idx}>
            <div className="info">
              <p>{h.local || 'Local desconhecido'}</p>
              <p>{formatData(h.data_compra)} • qtd: {h.quantidade || '?'} • {h.uf || ''}</p>
            </div>
            <div className="value value-stack">
              <span>{formatValor(h.valor_total)}</span>
              {h.preco_unitario != null && (
                <span className="value-sub">{formatPrecoUnitario(h.preco_unitario, h.unidade)}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Comparacao({ data }) {
  if (!data || !data.lojas || data.lojas.length < 2) return null;
  return (
    <div className="comparacao-section">
      <h2><i className="ti ti-building-store" aria-hidden="true" />Comparação entre lojas</h2>
      {data.lojas.map((loja, idx) => {
        const isPrimeiro = idx === 0;
        return (
          <div className={`loja-card ${isPrimeiro ? 'melhor' : ''}`} key={idx}>
            <div className="loja-card-header">
              <p className="loja-card-nome">{loja.local || 'Estabelecimento'}</p>
              <span className={`loja-rank ${isPrimeiro ? 'primeiro' : 'outros'}`}>
                {isPrimeiro ? (<><i className="ti ti-trophy" aria-hidden="true" /> Mais barato</>) : `${idx + 1}º lugar`}
              </span>
            </div>
            <div className="loja-card-valores">
              <span>
                <strong>{formatValor(loja.menor_valor)}</strong> menor{' '}
                {loja.menor_preco_unitario && (
                  <span className="loja-preco-un">({formatPrecoUnitario(loja.menor_preco_unitario, loja.unidade)})</span>
                )}
              </span>
              <span><strong>{formatValor(loja.ultimo_valor)}</strong> último</span>
            </div>
            <p className="loja-vezes">
              {loja.vezes_comprado} compra{loja.vezes_comprado !== 1 ? 's' : ''} registrada{loja.vezes_comprado !== 1 ? 's' : ''} • {loja.uf || ''}
            </p>
          </div>
        );
      })}
    </div>
  );
}