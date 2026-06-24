import { useEffect, useState } from 'react';
import { Loading, EmptyState, Alert } from '../components/Feedback';
import ConfirmModal from '../components/ConfirmModal';
import { apiGet, apiPost } from '../lib/api';
import { formatData } from '../lib/format';

export default function MesclagensTab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [mesclagens, setMesclagens] = useState(null);
  const [pendingUndo, setPendingUndo] = useState(null); // { nome_final }
  const [undoingNome, setUndoingNome] = useState(null);
  
  // Estados para a nova interface de consolidação
  const [showMigrateConfirm, setShowMigrateConfirm] = useState(false);
  const [migrateSecret, setMigrateSecret] = useState('');
  const [consolidando, setConsolidando] = useState(false);

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
    // Tenta pegar o secret da URL inicialmente
    const urlParams = new URLSearchParams(window.location.search);
    const secret = urlParams.get('secret');
    if (secret) setMigrateSecret(secret);
  }, []);

  async function confirmarDesfazer() {
    if (!pendingUndo) return;
    const { nome_final } = pendingUndo;
    setPendingUndo(null);
    setUndoingNome(nome_final);
    try {
      await apiPost('/mesclar-produtos', { action: 'unmerge', descricao_mesclada: nome_final });
      setMesclagens((prev) => prev.filter((m) => m.nome_final !== nome_final));
      setSuccess('Mesclagem desfeita com sucesso.');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setUndoingNome(null);
    }
  }

  async function executarConsolidacao() {
    if (!migrateSecret) {
      setError('Por favor, informe a senha para continuar.');
      return;
    }

    setConsolidando(true);
    setError(null);
    setSuccess(null);
    setShowMigrateConfirm(false);

    try {
      const res = await apiPost(`/migrate?secret=${encodeURIComponent(migrateSecret)}`);
      if (res.ok) {
        setSuccess(`Sucesso! ${res.grupos_mesclados || 0} grupos de produtos foram unificados.`);
        carregar();
      }
    } catch (err) {
      setError("Erro ao consolidar: " + err.message);
    } finally {
      setConsolidando(false);
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
        
        <div className="btn-group-row" style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <button className="btn" onClick={carregar} style={{ flex: 1 }}>
            <i className="ti ti-refresh" aria-hidden="true" /> Atualizar lista
          </button>
          <button 
            className="btn btn-secondary" 
            onClick={() => setShowMigrateConfirm(true)}
            disabled={consolidando}
            style={{ flex: 1 }}
          >
            <i className={`ti ${consolidando ? 'ti-loader-2 spin' : 'ti-wand'}`} aria-hidden="true" />
            {consolidando ? 'Consolidando...' : 'Consolidar Banco'}
          </button>
        </div>

        {/* Interface Integrada de Senha/Confirmação */}
        {showMigrateConfirm && (
          <div className="alert alert-info" style={{ marginBottom: '20px', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '15px' }}>
            <h4 style={{ marginTop: 0, marginBottom: '10px' }}>Consolidar Banco</h4>
            <p style={{ fontSize: '0.9rem', marginBottom: '15px' }}>
              Isso vai varrer todo o banco em busca de nomes similares e mesclá-los automaticamente.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>Senha de Segurança (MIGRATE_SECRET):</label>
              <input 
                type="password" 
                className="input" 
                placeholder="Digite a senha..."
                value={migrateSecret}
                onChange={(e) => setMigrateSecret(e.target.value)}
                style={{ width: '100%', padding: '8px' }}
              />
              <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                <button className="btn btn-primary" onClick={executarConsolidacao} style={{ flex: 1 }}>
                  Confirmar e Iniciar
                </button>
                <button className="btn btn-ghost" onClick={() => setShowMigrateConfirm(false)} style={{ flex: 1 }}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="result-area">
          {loading && <Loading text="Carregando mesclagens..." />}
          {!loading && error && <Alert tone="danger">{error}</Alert>}
          {!loading && success && <Alert tone="success">{success}</Alert>}
          
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
