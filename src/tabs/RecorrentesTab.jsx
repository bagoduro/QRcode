import { useState } from 'react';
import { Loading, EmptyState, Alert } from '../components/Feedback';
import { apiGet } from '../lib/api';
import { formatValor, formatData } from '../lib/format';

export default function RecorrentesTab({ onVerProduto }) {
  const [minCompras, setMinCompras] = useState('2');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resultado, setResultado] = useState(null);

  async function carregar() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet('/historico-compras', { recorrentes: 'true', min_compras: minCompras });
      setResultado(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const itens = resultado?.itens_recorrentes || [];

  return (
    <section className="panel active">
      <div className="card">
        <h2>Itens que você compra com frequência</h2>
        <div className="field">
          <label htmlFor="select-min">Mínimo de compras para considerar recorrente</label>
          <select id="select-min" value={minCompras} onChange={(e) => setMinCompras(e.target.value)}>
            <option value="2">2 ou mais vezes</option>
            <option value="3">3 ou mais vezes</option>
            <option value="5">5 ou mais vezes</option>
          </select>
        </div>
        <button className="btn primary full" onClick={carregar}>
          <i className="ti ti-refresh" aria-hidden="true" /> Carregar
        </button>

        <div className="result-area">
          {loading && <Loading text="Analisando seu histórico..." />}
          {!loading && error && <Alert tone="danger">{error}</Alert>}
          {!loading && resultado && itens.length === 0 && (
            <EmptyState icon="ti-repeat-off" text="Nenhum item recorrente encontrado ainda. Registre mais notas para identificar padrões." />
          )}
          {!loading && itens.length > 0 && (
            <>
              <p className="helper helper-spaced">
                {resultado.total} item(ns) comprados {resultado.criterio_minimo_compras}+ vezes. Toque em um item para ver o histórico completo.
              </p>
              <div className="item-list">
                {itens.map((item, idx) => {
                  const mesmoLocal = item.ultima_compra.local === item.menor_preco.local;
                  return (
                    <div className="item-card" key={idx} onClick={() => onVerProduto(item.descricao || '')}>
                      <div className="top-row">
                        <p>{item.descricao || 'Item'}</p>
                        <span>{item.vezes_comprado}x comprado</span>
                      </div>
                      <div className="meta">
                        Última vez: {formatValor(item.ultima_compra.valor_total)} em {item.ultima_compra.local || '-'} ({formatData(item.ultima_compra.data_compra)})
                      </div>
                      <span className={`badge ${mesmoLocal ? 'last' : 'best'}`}>
                        <i className="ti ti-tag" aria-hidden="true" />
                        Melhor preço: {formatValor(item.menor_preco.valor_total)} {mesmoLocal ? '' : 'em ' + item.menor_preco.local}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
