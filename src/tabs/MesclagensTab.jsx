import { useEffect, useState } from 'react';
import { Loading, EmptyState, Alert } from '../components/Feedback';
import ConfirmModal from '../components/ConfirmModal';
import { apiGet, apiPost } from '../lib/api';
import { formatData } from '../lib/format';

export default function MesclagensTab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mesclagens, setMesclagens] = useState(null);
  const [pendingUndo, setPendingUndo] = useState(null); // { nome_final }
  const [undoingNome, setUndoingNome] = useState(null);

  async function carregar() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet('/mesclar-produtos');
      setMesclagens(data.mesclagens || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  async function confirmarDesfazer() {
    if (!pendingUndo) return;
    const { nome_final } = pendingUndo;
    setPendingUndo(null);
    setUndoingNome(nome_final);
    try {
      await apiPost('/mesclar-produtos', { action: 'unmerge', descricao_mesclada: nome_final });
      setMesclagens((prev) => prev.filter((m) => m.nome_final !== nome_final));
    } catch (err) {
      setError(err.message);
    } finally {
      setUndoingNome(null);
    }
  }

  return (
    <section className="panel active">
      <div className="card">
        <h2>Produtos mesclados</h2>
        <p className="helper helper-spaced">
          Aqui ficam todos os produtos que foram unificados — automaticamente pelo Fuse.js ou manualmente por você.
          Pode desfazer qualquer mesclagem a qualquer momento.
        </p>
        <button className="btn full" onClick={carregar}>
          <i className="ti ti-refresh" aria-hidden="true" /> Atualizar lista
        </button>

        <div className="result-area">
          {loading && <Loading text="Carregando mesclagens..." />}
          {!loading && error && <Alert tone="danger">{error}</Alert>}
          {!loading && mesclagens && mesclagens.length === 0 && (
            <EmptyState icon="ti-git-merge" text="Nenhum produto mesclado ainda." />
          )}
          {!loading && mesclagens && mesclagens.length > 0 && (
            <div className="item-list">
              {mesclagens.map((m) => (
                <div className="item-card mesclagem-card" key={m.nome_final}>
                  <div className="top-row">
                    <p>{m.nome_final}</p>
                  </div>
                  <div className="meta">
                    {m.origens.length} nome{m.origens.length !== 1 ? 's' : ''} original
                    {m.origens.length !== 1 ? 'is' : ''} unificado{m.origens.length !== 1 ? 's' : ''}
                    {m.atualizado_em ? ` • ${formatData(m.atualizado_em)}` : ''}
                  </div>
                  <div className="mesclagem-origens">
                    {m.origens.map((o, idx) => (
                      <span className="mesclagem-origem-chip" key={idx}>
                        {o.descricao}
                      </span>
                    ))}
                  </div>
                  <button
                    className="btn-excluir-nota"
                    disabled={undoingNome === m.nome_final}
                    onClick={() => setPendingUndo({ nome_final: m.nome_final })}
                  >
                    <i className={`ti ${undoingNome === m.nome_final ? 'ti-loader-2 spin' : 'ti-git-pull-request'}`} aria-hidden="true" />
                    {undoingNome === m.nome_final ? 'Desfazendo...' : 'Desfazer mesclagem'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {pendingUndo && (
        <ConfirmModal
          title="Desfazer mesclagem"
          message={`Os nomes originais voltarão a aparecer separados de "${pendingUndo.nome_final}". Tem certeza?`}
          confirmLabel="Desfazer"
          onConfirm={confirmarDesfazer}
          onCancel={() => setPendingUndo(null)}
        />
      )}
    </section>
  );
}
