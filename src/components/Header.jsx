export default function Header({ auth, onOpenLogin, onLogout }) {
  return (
    <header className="app-header">
      <div className="header-auth">
        {auth.loggedIn ? (
          <>
            <span className="auth-user">
              <i className="ti ti-user-circle" aria-hidden="true" /> {auth.username}
            </span>
            <button className="btn-logout" onClick={onLogout}>
              <i className="ti ti-logout" aria-hidden="true" /> Sair
            </button>
          </>
        ) : (
          <button className="btn-entrar" onClick={onOpenLogin}>
            <i className="ti ti-login" aria-hidden="true" /> Entrar
          </button>
        )}
      </div>
      <div className="header-brand">
        <div className="header-logo">
          <i className="ti ti-receipt-2" aria-hidden="true" />
        </div>
        <div>
          <h1>Histórico de compras</h1>
          <p>Leia notas fiscais por QR code e compare preços entre estabelecimentos</p>
        </div>
      </div>
    </header>
  );
}
