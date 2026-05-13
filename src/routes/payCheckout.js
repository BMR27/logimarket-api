const express = require('express');

const router = express.Router();

router.get('/:paymentToken', (req, res) => {
  const paymentToken = String(req.params.paymentToken || '').trim();
  if (!paymentToken) {
    return res.status(400).send('paymentToken requerido');
  }

  const logoUrl = process.env.PUBLIC_COMPANY_LOGO_URL || '';
  const safeToken = paymentToken.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Pago de entrega</title>
  <style>
    :root {
      --bg: #f2f6fb;
      --card: #ffffff;
      --text: #1c2733;
      --muted: #5f7285;
      --primary: #0b57d0;
      --ok: #1b8f4b;
      --warn: #cc7a00;
      --bad: #c62828;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(1200px 500px at 10% -10%, #d7e8ff 0, #f2f6fb 45%), var(--bg);
      color: var(--text);
      font: 16px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      width: 100%;
      max-width: 560px;
      background: var(--card);
      border-radius: 20px;
      box-shadow: 0 20px 70px rgba(14, 44, 84, 0.12);
      overflow: hidden;
    }
    .head {
      background: linear-gradient(135deg, #0f4db8, #2d79e9);
      color: white;
      padding: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand .logo {
      width: 48px;
      height: 48px;
      border-radius: 999px;
      background: rgba(255,255,255,0.25);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      font-weight: 700;
    }
    .brand .logo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .body { padding: 22px; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
    .item {
      background: #f7fafe;
      border: 1px solid #e2edf8;
      border-radius: 12px;
      padding: 10px 12px;
    }
    .label {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
    .value {
      margin: 3px 0 0;
      font-weight: 700;
    }
    .status {
      padding: 10px 12px;
      border-radius: 10px;
      font-weight: 600;
      margin: 8px 0 14px;
      background: #edf2f8;
      color: #35516d;
    }
    .status.waiting { background: #edf2f8; color: #35516d; }
    .status.paid { background: #e6f6eb; color: var(--ok); }
    .status.expired { background: #fff2df; color: var(--warn); }
    .status.failed, .status.cancelled { background: #fde7e7; color: var(--bad); }
    .methods { margin: 0 0 14px; color: var(--muted); }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 12px;
      padding: 12px 16px;
      cursor: pointer;
      font-weight: 700;
      transition: transform .1s ease;
    }
    button:active { transform: scale(.98); }
    #payBtn { background: var(--primary); color: white; }
    #refreshBtn { background: #e7eef8; color: #335170; }
    #message {
      margin-top: 12px;
      color: var(--muted);
      min-height: 22px;
    }
    @media (max-width: 640px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="card">
    <section class="head">
      <div class="brand">
        <span class="logo">${logoUrl ? `<img src="${logoUrl}" alt="Logo"/>` : 'LM'}</span>
        <div>
          <h1 style="margin:0;font-size:1.25rem;">Pago de entrega</h1>
          <p style="margin:2px 0 0;opacity:.9">Checkout seguro</p>
        </div>
      </div>
    </section>

    <section class="body">
      <div class="grid">
        <article class="item"><p class="label">Numero de guia</p><p id="trackingNumber" class="value">-</p></article>
        <article class="item"><p class="label">Cliente</p><p id="customerName" class="value">-</p></article>
        <article class="item"><p class="label">Monto exacto a pagar</p><p id="amount" class="value">-</p></article>
        <article class="item"><p class="label">Concepto</p><p class="value">Entrega de pedido</p></article>
      </div>

      <div id="statusBox" class="status waiting">Cargando...</div>
      <p class="methods" id="methods">Metodos de pago disponibles: -</p>
      <p class="methods" id="expires">-</p>

      <div class="actions">
        <button id="payBtn" type="button">Pagar ahora</button>
        <button id="refreshBtn" type="button">Actualizar estado</button>
      </div>
      <p id="message"></p>
    </section>
  </main>

  <script>
    const token = ${JSON.stringify(safeToken)};
    const statusBox = document.getElementById('statusBox');
    const payBtn = document.getElementById('payBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const message = document.getElementById('message');
    let pollTimer = null;

    function money(amount, currency) {
      try {
        return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(Number(amount || 0));
      } catch (_) {
        return String(amount) + ' ' + (currency || 'MXN');
      }
    }

    function setStatusVisual(status) {
      const s = String(status || '').toUpperCase();
      statusBox.className = 'status';
      if (s === 'PAID') {
        statusBox.classList.add('paid');
        statusBox.textContent = 'Pago confirmado';
        payBtn.disabled = true;
      } else if (s === 'EXPIRED') {
        statusBox.classList.add('expired');
        statusBox.textContent = 'Este pago expiro';
        payBtn.disabled = true;
      } else if (s === 'FAILED') {
        statusBox.classList.add('failed');
        statusBox.textContent = 'El pago fue rechazado';
        payBtn.disabled = false;
      } else if (s === 'CANCELLED') {
        statusBox.classList.add('cancelled');
        statusBox.textContent = 'Pago cancelado';
        payBtn.disabled = true;
      } else {
        statusBox.classList.add('waiting');
        statusBox.textContent = 'Esperando pago';
        payBtn.disabled = false;
      }
    }

    function startPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(loadStatus, 5000);
    }

    async function loadCheckout() {
      message.textContent = 'Consultando pago...';
      const resp = await fetch('/api/public/payments/' + token);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'No se pudo consultar el pago');

      document.getElementById('trackingNumber').textContent = data.trackingNumber || '-';
      document.getElementById('customerName').textContent = data.customerName || '-';
      document.getElementById('amount').textContent = money(data.amount, data.currency);
      document.getElementById('methods').textContent = 'Metodos de pago disponibles: ' + (((data.methods || []).join(', ')) || '-');
      document.getElementById('expires').textContent = data.expiresAt ? ('Vence: ' + new Date(data.expiresAt).toLocaleString()) : '';
      setStatusVisual(data.status);
      message.textContent = '';
    }

    async function loadStatus() {
      const resp = await fetch('/api/public/payments/' + token + '/status');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'No se pudo consultar estado');
      setStatusVisual(data.status);
      if (String(data.status || '').toUpperCase() === 'PAID' && pollTimer) {
        clearInterval(pollTimer);
      }
    }

    async function payNow() {
      payBtn.disabled = true;
      message.textContent = 'Iniciando pago...';
      try {
        const resp = await fetch('/api/public/payments/' + token + '/pay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'checkout_page' }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'No se pudo iniciar pago');
        message.textContent = data.message || 'Pago iniciado, esperando confirmacion...';
        await loadStatus();
      } catch (err) {
        message.textContent = err.message || String(err);
        payBtn.disabled = false;
      }
    }

    payBtn.addEventListener('click', () => payNow());
    refreshBtn.addEventListener('click', () => loadStatus().catch((err) => { message.textContent = err.message || String(err); }));

    loadCheckout()
      .then(() => startPolling())
      .catch((err) => { message.textContent = err.message || String(err); });
  </script>
</body>
</html>`);
});

module.exports = router;
