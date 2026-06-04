import { useEffect, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";

function App() {
  const [resultado, setResultado] = useState(null);

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
        const json = {
          conteudo: textoLido,
          dataLeitura: new Date().toISOString(),
        };

        setResultado(json);
      },
      (erro) => {
        // Ignora erros de leitura
      }
    );

    return () => {
      scanner.clear().catch(() => {});
    };
  }, []);

  return (
    <div style={{ maxWidth: "600px", margin: "0 auto", padding: "20px" }}>
      <h1>📷 Leitor de QR Code</h1>

      <div id="reader"></div>

      {resultado && (
        <div>
          <h2>JSON Gerado</h2>

          <pre
            style={{
              background: "#f4f4f4",
              padding: "10px",
              borderRadius: "8px",
              overflow: "auto",
            }}
          >
            {JSON.stringify(resultado, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default App;