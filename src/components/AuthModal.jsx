import { useEffect, useRef, useState } from 'react';
import { authSubmit, setToken } from '../lib/api';

const COPY = {
  login: {
    title: 'Entrar na conta',
    subtitle: 'Acesse para salvar e editar notas fiscais',
    submitLabel: 'Entrar',
    submitIcon: 'ti-login',
    headerIcon: 'ti-receipt',
    toggleText: 'Não tem conta?',
    toggleAction: 'Criar conta',
  },
  register: {
    title: 'Criar conta',
    subtitle: 'Cadastre-se para começar a salvar notas',
    submitLabel: 'Criar conta',
    submitIcon: 'ti-user-plus',
    headerIcon: 'ti-user-plus',
    toggleText: 'Já tem conta?',
    toggleAction: 'Entrar',
  },
};

export default function AuthModal({ onClose, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  const copy = COPY[mode];

  async function handleSubmit() {
    setError('');
    if (!username.trim() || !password) {
      setError('Preencha usuário e senha.');
      return;
    }
    setLoading(true);
    try {
      const data = await authSubmit(mode, username.trim(), password);
      setToken(data.token);
      onAuthenticated(data.username || username.trim());
    } catch (err) {
      setError(err.message || 'Erro ao autenticar.');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleSubmit();
  }

  return (
    <div className="auth-overlay">
      <div className="auth-card">
        <button className="auth-back" onClick={onClose}>
          <i className="ti ti-arrow-left" aria-hidden="true" /> Voltar para o início
        </button>

        <div className="auth-icon">
          <i className={`ti ${copy.headerIcon}`} aria-hidden="true" />
        </div>

        <h2>{copy.title}</h2>
        <p className="auth-subtitle">{copy.subtitle}</p>

        {error && <div className="auth-error">{error}</div>}

        <div className="auth-field">
          <label htmlFor="auth-username">Usuário</label>
          <div className="auth-input-wrap">
            <i className="ti ti-user" aria-hidden="true" />
            <input
              ref={usernameRef}
              id="auth-username"
              type="text"
              placeholder="seu_usuario"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor="auth-password">Senha</label>
          <div className="auth-input-wrap">
            <i className="ti ti-lock" aria-hidden="true" />
            <input
              id="auth-password"
              type="password"
              placeholder="••••••"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>

        <button className="auth-submit" disabled={loading} onClick={handleSubmit}>
          <i className={`ti ${loading ? 'ti-loader-2 spin' : copy.submitIcon}`} aria-hidden="true" />
          <span>{loading ? 'Aguarde...' : copy.submitLabel}</span>
        </button>

        <div className="auth-divider">ou</div>

        <div className="auth-toggle">
          <span>{copy.toggleText}</span>{' '}
          <button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
            {copy.toggleAction}
          </button>
        </div>
      </div>
    </div>
  );
}
