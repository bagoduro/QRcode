import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

export default function Scanner({ onResult }) {
  const [scanning, setScanning] = useState(false);
  const [justScanned, setJustScanned] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const scanningRef = useRef(false);

  useEffect(() => () => stopScanner(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function startScanner() {
    setJustScanned(false);
    setScanning(true);
    scanningRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;

      const videoEl = videoRef.current;
      videoEl.srcObject = stream;
      await videoEl.play();

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      function tick() {
        if (!scanningRef.current) return;
        if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
          canvas.width = videoEl.videoWidth;
          canvas.height = videoEl.videoHeight;
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code && code.data) {
            setJustScanned(true);
            if (navigator.vibrate) navigator.vibrate(100);
            stopScanner();
            onResult(code.data);
            return;
          }
        }
        animFrameRef.current = requestAnimationFrame(tick);
      }

      animFrameRef.current = requestAnimationFrame(tick);
    } catch (err) {
      stopScanner();
      onResult(null, 'Não foi possível acessar a câmera: ' + (err.message || err));
    }
  }

  function stopScanner() {
    scanningRef.current = false;
    setScanning(false);
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
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

      <div className={`scanner-wrapper ${scanning ? 'active' : ''}`}>
        <video ref={videoRef} className="qr-video" autoPlay muted playsInline />
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
