const TABS = [
  { id: 'leitor', label: 'Ler nota', icon: 'ti-qrcode' },
  { id: 'buscar', label: 'Buscar item', icon: 'ti-search' },
  { id: 'recorrentes', label: 'Recorrentes', icon: 'ti-repeat' },
  { id: 'historico', label: 'Compras', icon: 'ti-receipt' },
  { id: 'mesclagens', label: 'Mesclagens', icon: 'ti-git-merge', somenteLogado: true },
];

export default function TabNav({ active, onChange, isLoggedIn }) {
  const tabs = TABS.filter((tab) => !tab.somenteLogado || isLoggedIn);

  return (
    <nav className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={`tab-btn ${active === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          <i className={`ti ${tab.icon}`} aria-hidden="true" />
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
