import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

export default function PriceChart({ historico }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || historico.length < 2) return;

    const crescente = [...historico].reverse();
    const labels = crescente.map((h) => {
      const d = h.data_compra ? new Date(h.data_compra) : null;
      return d && !isNaN(d) ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '?';
    });
    const valores = crescente.map((h) => {
      const v = h.preco_unitario ?? parseFloat(String(h.valor_total).replace(/[^\d,]/g, '').replace(',', '.'));
      return Number.isNaN(v) ? null : v;
    });

    const corLinha = '#1D9E75';

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            data: valores,
            borderColor: corLinha,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: corLinha,
            tension: 0.3,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `R$ ${Number(ctx.parsed.y).toFixed(2).replace('.', ',')}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            grid: { color: 'rgba(128,128,128,0.15)' },
            ticks: {
              font: { size: 11 },
              callback: (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`,
            },
          },
        },
      },
    });

    return () => chartRef.current?.destroy();
  }, [historico]);

  if (historico.length < 2) return null;

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}
