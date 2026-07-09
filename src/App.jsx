import { useEffect, useState } from 'react';
import Header from './components/Header';
import TabNav from './components/TabNav';
import AuthModal from './components/AuthModal';
import LeitorTab from './tabs/LeitorTab';
import BuscarTab from './tabs/BuscarTab';
import RecorrentesTab from './tabs/RecorrentesTab';
import HistoricoTab from './tabs/HistoricoTab';
import MesclagensTab from './tabs/MesclagensTab';
import { authMe, clearToken, getToken } from './lib/api';
import './App.css';

export default function App() {
  const [activeTab, setActiveTab] = useState('leitor');
  const [auth, setAuth] = useState({ loggedIn: false, username: '', checked: false });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [jumpToProduct, setJumpToProduct] = useState(null);

  useEffect(() => {
    async function checkAuth() {
      if (!getToken()) {
        setAuth({ loggedIn: false, username: '', checked: true });
        return;
      }
      try {
        const data = await authMe();
        if (data.loggedIn) {
          setAuth({ loggedIn: true, username: data.user.username, checked: true });
        } else {
          clearToken();
          setAuth({ loggedIn: false, username: '', checked: true });
        }
      } catch {
        setAuth({ loggedIn: false, username: '', checked: true });
      }
    }
    checkAuth();
  }, []);

  function handleAuthenticated(username) {
    setAuth({ loggedIn: true, username, checked: true });
    setShowAuthModal(false);
  }

  function handleLogout() {
    clearToken();
    setAuth({ loggedIn: false, username: '', checked: true });
    if (activeTab === 'mesclagens') setActiveTab('buscar');
  }

  function handleVerProdutoRecorrente(descricao) {
    setJumpToProduct(descricao);
    setActiveTab('buscar');
  }

  return (
    <div className={`app ${auth.loggedIn ? 'autenticado' : ''}`}>
      <Header auth={auth} onOpenLogin={() => setShowAuthModal(true)} onLogout={handleLogout} />

      <TabNav active={activeTab} onChange={setActiveTab} isLoggedIn={auth.loggedIn} />

      {activeTab === 'leitor' && <LeitorTab />}
      {activeTab === 'buscar' && (
        <BuscarTab
          isLoggedIn={auth.loggedIn}
          jumpToProduct={jumpToProduct}
          onJumpConsumed={() => setJumpToProduct(null)}
        />
      )}
      {activeTab === 'recorrentes' && <RecorrentesTab onVerProduto={handleVerProdutoRecorrente} />}
      {activeTab === 'historico' && <HistoricoTab />}
      {activeTab === 'mesclagens' && auth.loggedIn && <MesclagensTab />}

      {showAuthModal && (
        <AuthModal onClose={() => setShowAuthModal(false)} onAuthenticated={handleAuthenticated} />
      )}
    </div>
  );
}
