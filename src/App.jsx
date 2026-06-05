import { useEffect, useRef, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";

function App() {
  const [scanResult, setScanResult] = useState(null);
  const [nfeData, setNfeData] = useState(null);
  const [error, setError] = useState(null);
  const [manualUrl, setManualUrl] = useState("");
  const lastScannedUrl = useRef(null);

  const isValidUrl = (text) => {
    try {
      new URL(text);
      return true;
    } catch {
      return false;
    }
  };

  const API_BASE = '/api';

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
    if (manualUrl && isValidUrl(manualUrl)) {
      lastScannedUrl.current = manualUrl;
      fetchNfe(manualUrl);
    } else {
      setError('URL inválida.');
    }
  };

  const clearAll = () => {
    setScanResult(null);
    setNfeData(null);
    setError(null);
    lastScannedUrl.current = null;
    setManualUrl("");
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
          Consultar
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
