import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

const SCANNER_ELEMENT_ID = 'qr-camera-view';

export default function Scanner({ onResult }) {
  const [scanning, setScanning] = useState(false);
  const [justScanned, setJustScanned] = useState(false);
  const html5QrRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => () => stopScanner(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function startScanner() {
    setJustScanned(false);
    setScanning(true);

    try {
      const instance = new Html5Qrcode(SCANNER_ELEMENT_ID);
      html5QrRef.current = instance;

      await instance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 }, aspectRatio: 1 },
        (decodedText) => {
          setJustScanned(true);
          if (navigator.vibrate) navigator.vibrate(100);
          stopScanner();
          onResult(decodedText);
        },
        () => {
          // ignora frames sem leitura
        }
      );

      // Esconde os elementos default da lib (link de swap de câmera, etc.)
      const root = containerRef.current;
      if (root) {
        root.querySelectorAll('img, select, #' + SCANNER_ELEMENT_ID + '__dashboard_section_swaplink')
          .forEach((el) => { el.style.display = 'none'; });
      }
    } catch (err) {
      setScanning(false);
      onResult(null, 'Não foi possível acessar a câmera: ' + (err.message || err));
    }
  }

  async function stopScanner() {
    setScanning(false);
    const instance = html5QrRef.current;
    if (instance) {
      try {
        await instance.stop();
        instance.clear();
      } catch {
        // já parado
      }
      html5QrRef.current = null;
    }
  }

  function handleToggle() {
    if (scanning) stopScanner();
    else startScanner();
  }

  return (
    <div className="scanner-frame">
      {!scanning && (
        <>
          <i className="ti ti-camera" aria-hidden="true" />
          <p>Aponte a câmera para o QR code da nota fiscal</p>
        </>
      )}

      <button className="btn primary full" onClick={handleToggle}>
        <i className={`ti ${scanning ? 'ti-player-stop' : 'ti-player-play'}`} aria-hidden="true" />
        {scanning ? 'Parar câmera' : 'Iniciar câmera'}
      </button>

      <div className={`scanner-wrapper ${scanning ? 'active' : ''}`} ref={containerRef}>
        <div id={SCANNER_ELEMENT_ID} className="qr-camera-view" />
        <div className="scanner-overlay">
          <div className="scanner-box">
            <div className="scan-line" />
            <div className="corner-br" />
            <div className="corner-bl" />
          </div>
          <p className="scanner-hint">Centralize o QR code no quadro</p>
        </div>
      </div>

      <div className={`scan-success ${justScanned ? 'show' : ''}`}>
        <i className="ti ti-check" aria-hidden="true" /> QR code lido! Consultando nota...
      </div>
    </div>
  );
}
