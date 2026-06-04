import { useEffect, useRef, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";

function App() {
  const [scanResult, setScanResult] = useState(null);
  const [nfeData, setNfeData] = useState(null);
  const [error, setError] = useState(null);
  const [manualUrl, setManualUrl] = useState("");
  const [manualAccessKey, setManualAccessKey] = useState("");
  const [selectedState, setSelectedState] = useState("PE");
  const lastScannedUrl = useRef(null);

  // Mapeamento de SEFAZ por estado
  const sefazUrls = {
    PE: "https://consulta.sefaz.pe.gov.br/nfce/consulta?chAcesso=",
    SP: "https://nfce.fazenda.sp.gov.br/consulta?chAcesso=",
    MG: "https://nfce.fazenda.mg.gov.br/portal/consulta?chAcesso=",
    BA: "https://nfce.sefaz.ba.gov.br/consulta?chAcesso=",
    RS: "https://nfce.sefaz.rs.gov.br/consulta?chAcesso=",
    RJ: "https://nfce.sefaz.rj.gov.br/consulta?chAcesso=",
  };

  const isValidUrl = (text) => {
    try {
      new URL(text);
      return true;
    } catch {
      return false;
    }
  };

  const isValidAccessKey = (text) => {
    // Chave de acesso tem 44 dígitos
    return /^\d{44}$/.test(text.replace(/\D/g, ''));
  };

  const buildUrlFromAccessKey = (accessKey, state = "PE") => {
    // Remove caracteres não numéricos
    const cleanKey = accessKey.replace(/\D/g, '');
    const baseUrl = sefazUrls[state] || sefazUrls.PE;
    return `${baseUrl}${cleanKey}`;
  };

  const API_BASE = import.meta.env.VITE_API_BASE || '';

  const fetchNfe = async (url) => {
    try {
      setError(null);
      const endpoint = API_BASE
        ? `${API_BASE.replace(/\/$/, '')}/consulta-qrcode?url=${encodeURIComponent(url)}`
        : `/api/consulta-qrcode?url=${encodeURIComponent(url)}`;

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Erro ${response.status}: ${body}`);
      }

      const json = await response.json();
      setNfeData(json);
      setError(null);
    } catch (err) {
      setNfeData(null);
      setError(err.message);
    }
  };

  useEffect(() => {
    const scanner = new Html5QrcodeScanner(
      "reader",
      {
        fps: 10,
        qrbox: 250,
      },
      false
    );

    scanner.render(
      (textoLido) => {
        setScanResult(textoLido);

        if (isValidUrl(textoLido) && textoLido !== lastScannedUrl.current) {
          lastScannedUrl.current = textoLido;
          fetchNfe(textoLido);
        }
      },
      () => {
        // Ignora erros de leitura
      }
    );

    return () => {
      scanner.clear().catch(() => {});
    };
  }, []);

  const handleReconsult = () => {
    if (lastScannedUrl.current) fetchNfe(lastScannedUrl.current);
  };

  const handleManualConsult = () => {
    let urlToFetch = null;

    // Se tiver chave de acesso, usar ela
    if (manualAccessKey && isValidAccessKey(manualAccessKey)) {
      urlToFetch = buildUrlFromAccessKey(manualAccessKey, selectedState);
    } 
    // Senão, tentar usar URL diretamente
    else if (manualUrl && isValidUrl(manualUrl)) {
      urlToFetch = manualUrl;
    } 
    else {
      setError('Cole a URL do QR Code ou a chave de acesso (44 dígitos).');
      return;
    }

    lastScannedUrl.current = urlToFetch;
    fetchNfe(urlToFetch);
  };

  const clearAll = () => {
    setScanResult(null);
    setNfeData(null);
    setError(null);
    lastScannedUrl.current = null;
    setManualUrl("");
    setManualAccessKey("");
  };

  return (
    <div className="app-container">
      <h1>📷 Leitor de QR Code</h1>

      <div id="reader" className="reader-container" />

      <div className="info-row">
        <div className="last-read">
          <h3>Último conteúdo lido</h3>
          <p className="mono">{scanResult || "Aguardando leitura..."}</p>
        </div>

        <div className="actions">
          <button onClick={handleReconsult} disabled={!lastScannedUrl.current} className="btn">
            Reconsultar
          </button>
          <button onClick={clearAll} className="btn btn-ghost">
            Limpar
          </button>
        </div>
      </div>

      <div className="manual-consult">
        <input
          value={manualUrl}
          onChange={(e) => setManualUrl(e.target.value)}
          placeholder="Cole a URL do QR Code aqui"
        />
        <button onClick={handleManualConsult} className="btn">
          Consultar por URL
        </button>
      </div>

      <div className="manual-consult" style={{ marginTop: "15px" }}>
        <h4 style={{ marginBottom: "10px" }}>Ou use a chave de acesso:</h4>
        <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
          <select 
            value={selectedState} 
            onChange={(e) => setSelectedState(e.target.value)}
            style={{ flex: "0 0 80px" }}
          >
            <option value="PE">PE</option>
            <option value="SP">SP</option>
            <option value="MG">MG</option>
            <option value="BA">BA</option>
            <option value="RS">RS</option>
            <option value="RJ">RJ</option>
          </select>
          <input
            value={manualAccessKey}
            onChange={(e) => setManualAccessKey(e.target.value)}
            placeholder="Cole a chave de acesso (44 dígitos)"
            maxLength="60"
            style={{ flex: 1 }}
          />
        </div>
        <button onClick={handleManualConsult} className="btn">
          Consultar por Chave
        </button>
      </div>

      {error && <div className="error">Erro: {error}</div>}

      {nfeData && (
        <div className="nfe-card">
          <h2>Dados NFC-e</h2>

          <section className="section">
            <h4>Emitente</h4>
            <div className="grid">
              <div><strong>Nome:</strong> {nfeData.emitente?.nome || '-'}</div>
              <div><strong>CNPJ:</strong> {nfeData.emitente?.cnpj || '-'}</div>
              <div><strong>IE:</strong> {nfeData.emitente?.inscricao_estadual || '-'}</div>
              <div><strong>UF:</strong> {nfeData.emitente?.uf || '-'}</div>
            </div>
          </section>

          <section className="section">
            <h4>Nota</h4>
            <div className="grid">
              <div><strong>Modelo:</strong> {nfeData.nota?.modelo || '-'}</div>
              <div><strong>Série:</strong> {nfeData.nota?.serie || '-'}</div>
              <div><strong>Número:</strong> {nfeData.nota?.numero || '-'}</div>
              <div><strong>Emissão:</strong> {nfeData.nota?.data_emissao || '-'}</div>
              <div><strong>Valor total serviço:</strong> {nfeData.nota?.valor_total_servico || '-'}</div>
              <div><strong>Protocolo:</strong> {nfeData.nota?.protocolo || '-'}</div>
            </div>
          </section>

          <section className="section">
            <h4>Totais</h4>
            <div className="grid">
              <div><strong>Qtde total itens:</strong> {nfeData.totais?.quantidade_total_itens || '-'}</div>
              <div><strong>Valor total:</strong> {nfeData.totais?.valor_total || '-'}</div>
              <div><strong>Pago:</strong> {nfeData.totais?.valor_pago || '-'}</div>
              <div><strong>Pagamento:</strong> {nfeData.totais?.forma_pagamento || '-'}</div>
            </div>
          </section>

          <section className="section">
            <h4>Itens</h4>
            <div className="table-wrap">
              <table className="nfe-table">
                <thead>
                  <tr>
                    <th>Descrição</th>
                    <th>Código</th>
                    <th>Qtd</th>
                    <th>UN</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.isArray(nfeData.itens) && nfeData.itens.map((it, idx) => (
                    <tr key={idx}>
                      <td>{it.descricao}</td>
                      <td>{it.codigo}</td>
                      <td>{it.quantidade}</td>
                      <td>{it.unidade}</td>
                      <td>{it.valor_total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
