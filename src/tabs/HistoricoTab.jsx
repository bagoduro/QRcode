import { useEffect, useState } from 'react';
import { Loading, EmptyState, Alert } from '../components/Feedback';
import ConfirmModal from '../components/ConfirmModal';
import { apiDelete, apiGet } from '../lib/api';
import { formatValor, formatData } from '../lib/format';

export default function HistoricoTab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [compras, setCompras] = useState(null);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // { url, idx }
  const [deletingIdx, setDeletingIdx] = useState(null);

  async function carregar() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet('/historico-compras');
      setCompras(data.compras || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  function toggleExpand(idx) {
    setExpandedIdx((prev) => (prev === idx ? null : idx));
  }

  async function confirmarExclusao() {
    if (!pendingDelete) return;
    const { url, idx } = pendingDelete;
    setPendingDelete(null);
    setDeletingIdx(idx);
    try {
      await apiDelete('/historico-compras', { url });
      setCompras((prev) => prev.filter((_, i) => i !== idx));
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingIdx(null);
    }
  }

  return (
    <section className="panel active">
      <div className="card">
        <h2>Suas notas registradas</h2>
        <button className="btn full" onClick={carregar}>
          <i className="ti ti-refresh" aria-hidden="true" /> Atualizar lista
        </button>

        <div className="result-area">
          {loading && <Loading text="Carregando suas compras..." />}
          {!loading && error && <Alert tone="danger">{error}</Alert>}
          {!loading && compras && compras.length === 0 && (
            <EmptyState icon="ti-receipt-off" text={'Nenhuma compra registrada ainda. Escaneie sua primeira nota na aba "Ler nota".'} />
          )}
          {!loading && compras && compras.length > 0 && (
            <>
              <p className="helper helper-spaced">{compras.length} nota(s) registrada(s).</p>
              <div className="item-list">
                {compras.map((c, idx) => (
                  <div className={`item-card ${expandedIdx === idx ? 'expanded' : ''} ${deletingIdx === idx ? 'removing' : ''}`} key={c.url || idx}>
                    <div className="top-row" onClick={() => toggleExpand(idx)}>
                      <p>{c.local || 'Estabelecimento'}</p>
                      <span>{formatValor(c.valor_total)} <i className="ti ti-chevron-down chevron" aria-hidden="true" /></span>
                    </div>
                    <div className="meta" onClick={() => toggleExpand(idx)}>
                      {formatData(c.data_compra)} • {c.quantidade_itens || (c.itens || []).length} ite{(c.itens || []).length === 1 ? 'm' : 'ns'}
                    </div>
                    <div className="nota-itens">
                      {(c.itens || []).length === 0 ? (
                        <EmptyState icon="ti-package-off" text="Nenhum item registrado" />
                      ) : (
                        c.itens.map((item, i) => (
                          <div className="result-row" key={i}>
                            <div className="info">
                              <p>{item.descricao || 'Item'}</p>
                              <p>Cód: {item.codigo || '-'} • Qtd: {item.quantidade || '-'}</p>
                            </div>
                            <div className="value">{formatValor(item.valor_total)}</div>
                          </div>
                        ))
                      )}
                      <button
                        className="btn-excluir-nota somente-logado"
                        onClick={(e) => { e.stopPropagation(); setPendingDelete({ url: c.url, idx }); }}
                      >
                        <i className="ti ti-trash" aria-hidden="true" /> Excluir esta nota
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {pendingDelete && (
        <ConfirmModal
          title="Excluir nota"
          message="Tem certeza que deseja excluir esta nota? Essa ação não pode ser desfeita."
          confirmLabel="Excluir"
          onConfirm={confirmarExclusao}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
