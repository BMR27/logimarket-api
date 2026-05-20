const express = require('express');

const router = express.Router();

router.get('/:paymentToken', (req, res) => {
  const paymentToken = String(req.params.paymentToken || '').trim();
  if (!paymentToken) {
    return res.status(400).send('paymentToken requerido');
  }

  // Permitir scripts inline para esta página de checkout pública
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:",
  );

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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(1200px 500px at 10% -10%, #d7e8ff 0, #f2f6fb 45%), var(--bg);
      color: var(--text);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 20px 12px 40px;
    }
    .card {
      width: 100%;
      max-width: 560px;
      background: var(--card);
      border-radius: 20px;
      box-shadow: 0 20px 70px rgba(14,44,84,.12);
      overflow: hidden;
    }
    .head {
      background: linear-gradient(135deg, #0f4db8, #2d79e9);
      color: white;
      padding: 20px 22px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo {
      width: 46px; height: 46px; border-radius: 50%;
      background: rgba(255,255,255,.25);
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 15px; overflow: hidden; flex-shrink: 0;
    }
    .logo img { width: 100%; height: 100%; object-fit: cover; }
    .head h1 { font-size: 1.2rem; margin-bottom: 2px; }
    .head p  { opacity: .85; font-size: .85rem; }
    .body { padding: 22px; }

    /* Status banner */
    .status-bar {
      border-radius: 10px; padding: 10px 14px;
      font-weight: 600; font-size: .9rem;
      margin-bottom: 18px;
    }
    .status-bar.waiting  { background: #e8f0fe; color: #1a56db; }
    .status-bar.review   { background: #fff8e1; color: #b45309; }
    .status-bar.paid     { background: #e6f6eb; color: var(--ok); }
    .status-bar.expired  { background: #fff2df; color: var(--warn); }
    .status-bar.failed   { background: #fde7e7; color: var(--bad); }

    /* Info grid */
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 18px;
    }
    .item {
      background: #f7fafe;
      border: 1px solid #e2edf8;
      border-radius: 12px;
      padding: 10px 12px;
    }
    .item.wide { grid-column: 1 / -1; }
    .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; margin-bottom: 3px; }
    .value { font-weight: 700; font-size: .95rem; word-break: break-all; }
    .amount-value { font-size: 1.4rem; color: var(--primary); }

    /* Transfer section */
    .section-title {
      font-size: .75rem; text-transform: uppercase; letter-spacing: .6px;
      color: var(--muted); font-weight: 600;
      margin: 20px 0 10px;
      display: flex; align-items: center; gap: 8px;
    }
    .section-title::after {
      content: ''; flex: 1; height: 1px; background: #e2edf8;
    }

    /* Copy row */
    .copy-row {
      display: flex; align-items: center;
      background: #f7fafe; border: 1px solid #e2edf8;
      border-radius: 12px; padding: 10px 12px;
      margin-bottom: 8px; gap: 10px;
    }
    .copy-row .info { flex: 1; min-width: 0; }
    .copy-row .info .label { margin-bottom: 2px; }
    .copy-row .info .value { font-size: .9rem; }
    .copy-btn {
      flex-shrink: 0; background: #e8f0fe; color: var(--primary);
      border: none; border-radius: 8px; padding: 7px 12px;
      cursor: pointer; font-size: .78rem; font-weight: 600;
      transition: background .15s;
    }
    .copy-btn:hover { background: #d2e3fc; }

    /* Action buttons */
    .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 22px; }
    .btn {
      width: 100%; padding: 13px; border: none; border-radius: 12px;
      font-size: .95rem; font-weight: 700; cursor: pointer;
      transition: opacity .15s, transform .1s;
    }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn:not(:disabled):active { transform: scale(.98); }
    .btn-primary  { background: var(--primary); color: white; }
    .btn-outline  { background: #e7eef8; color: #335170; }
    .btn-success  { background: #1b8f4b; color: white; }

    /* Toast */
    #toast {
      position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
      background: #1c2733; color: white; padding: 9px 18px;
      border-radius: 20px; font-size: .85rem; font-weight: 500;
      opacity: 0; pointer-events: none; transition: opacity .3s;
      white-space: nowrap; z-index: 999;
    }
    #toast.show { opacity: 1; }
    #message { margin-top: 12px; font-size: .88rem; color: var(--muted); min-height: 20px; text-align: center; }
    #expires { font-size: .8rem; color: var(--muted); margin-top: 6px; text-align: center; }

    @media (max-width: 480px) {
      .grid { grid-template-columns: 1fr; }
      .item.wide { grid-column: 1; }
    }
  </style>
</head>
<body>
<main class="card">
  <section class="head">
    <div class="brand">
      <span class="logo">${logoUrl ? `<img src="${logoUrl}" alt="Logo"/>` : 'LM'}</span>
      <div>
        <h1>Pago de entrega</h1>
        <p>Transferencia SPEI</p>
      </div>
    </div>
  </section>

  <section class="body" id="bodySection">
    <!-- Se rellena por JS -->
    <div id="statusBar" class="status-bar waiting">Cargando información del pago...</div>

    <div class="grid" id="infoGrid">
      <div class="item">
        <p class="label">Número de guía</p>
        <p class="value" id="trackingNumber">—</p>
      </div>
      <div class="item">
        <p class="label">Cliente</p>
        <p class="value" id="customerName">—</p>
      </div>
      <div class="item wide">
        <p class="label">Monto exacto a pagar</p>
        <p class="value amount-value" id="amount">—</p>
      </div>
    </div>

    <p class="section-title">Datos bancarios para transferencia</p>

    <div class="copy-row" id="rowBanco">
      <div class="info">
        <p class="label">Banco / Beneficiario</p>
        <p class="value" id="bankLine">—</p>
      </div>
    </div>

    <div class="copy-row">
      <div class="info">
        <p class="label">CLABE</p>
        <p class="value" id="clabe">—</p>
      </div>
      <button class="copy-btn" id="copyClabe">Copiar</button>
    </div>

    <div class="copy-row">
      <div class="info">
        <p class="label">Referencia</p>
        <p class="value" id="reference">—</p>
      </div>
      <button class="copy-btn" id="copyRef">Copiar</button>
    </div>

    <div class="copy-row">
      <div class="info">
        <p class="label">Concepto</p>
        <p class="value" id="concept">—</p>
      </div>
      <button class="copy-btn" id="copyConcept">Copiar</button>
    </div>

    <div class="copy-row">
      <div class="info">
        <p class="label">Monto</p>
        <p class="value" id="amountCopy">—</p>
      </div>
      <button class="copy-btn" id="copyAmount">Copiar</button>
    </div>

    <div class="actions">
      <button class="btn btn-success" id="reportBtn" type="button">Ya realicé el pago</button>
      <button class="btn btn-outline" id="refreshBtn" type="button">Actualizar estado</button>
    </div>

    <p id="message"></p>
    <p id="expires"></p>
  </section>
</main>

<div id="toast"></div>

<script>
  const TOKEN = ${JSON.stringify(safeToken)};
  let _data = null;

  function money(v, c) {
    try { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: c || 'MXN' }).format(Number(v || 0)); }
    catch (_) { return String(v) + ' ' + (c || 'MXN'); }
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  }

  async function copyText(text, label) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast((label || 'Texto') + ' copiado');
    } catch (_) {
      // fallback legacy
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast((label || 'Texto') + ' copiado');
    }
  }

  function setStatus(status) {
    const bar = document.getElementById('statusBar');
    const s = String(status || '').toUpperCase();
    bar.className = 'status-bar';
    const reportBtn = document.getElementById('reportBtn');

    if (s === 'PAID') {
      bar.classList.add('paid');
      bar.textContent = '✓ Pago confirmado — tu pedido será entregado';
      reportBtn.disabled = true;
    } else if (s === 'UNDER_REVIEW' || s === 'CUSTOMER_REPORTED_PAYMENT') {
      bar.classList.add('review');
      bar.textContent = '⏳ Pago reportado — Finanzas está validando la transferencia';
      reportBtn.disabled = true;
    } else if (s === 'EXPIRED') {
      bar.classList.add('expired');
      bar.textContent = '⚠ Este enlace de pago ha expirado';
      reportBtn.disabled = true;
    } else if (s === 'FAILED' || s === 'CANCELLED') {
      bar.classList.add('failed');
      bar.textContent = 'El pago fue rechazado o cancelado';
      reportBtn.disabled = true;
    } else {
      bar.classList.add('waiting');
      bar.textContent = 'Esperando pago — realiza la transferencia con los datos de abajo';
      reportBtn.disabled = false;
    }
  }

  async function loadCheckout() {
    const resp = await fetch('/api/public/payments/' + TOKEN);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'No se pudo cargar el pago');
    }
    _data = await resp.json();

    document.getElementById('trackingNumber').textContent = _data.trackingNumber || '—';
    document.getElementById('customerName').textContent   = _data.customerName   || '—';

    const amountFormatted = money(_data.amount, _data.currency);
    document.getElementById('amount').textContent     = amountFormatted;
    document.getElementById('amountCopy').textContent = amountFormatted;

    const bankLine = [_data.bankName, _data.beneficiaryName].filter(Boolean).join(' / ') || '—';
    document.getElementById('bankLine').textContent  = bankLine;
    document.getElementById('clabe').textContent     = _data.clabe     || '—';
    document.getElementById('reference').textContent = _data.reference || '—';
    document.getElementById('concept').textContent   = _data.concept   || '—';

    if (_data.expiresAt) {
      document.getElementById('expires').textContent =
        'Vence: ' + new Date(_data.expiresAt).toLocaleString('es-MX');
    }

    setStatus(_data.status);
    document.getElementById('message').textContent = '';
  }

  async function refreshStatus() {
    const resp = await fetch('/api/public/payments/' + TOKEN + '/status');
    if (!resp.ok) return;
    const d = await resp.json();
    setStatus(d.status);
  }

  async function reportPayment() {
    const btn = document.getElementById('reportBtn');
    btn.disabled = true;
    document.getElementById('message').textContent = 'Enviando reporte...';
    try {
      const resp = await fetch('/api/public/payments/' + TOKEN + '/report-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'No se pudo reportar el pago');
      document.getElementById('message').textContent = data.message || 'Pago reportado correctamente.';
      setStatus(data.status || 'UNDER_REVIEW');
    } catch (err) {
      document.getElementById('message').textContent = err.message || String(err);
      btn.disabled = false;
    }
  }

  // Copy buttons
  document.getElementById('copyClabe').addEventListener('click',   () => copyText(_data?.clabe,     'CLABE'));
  document.getElementById('copyRef').addEventListener('click',     () => copyText(_data?.reference, 'Referencia'));
  document.getElementById('copyConcept').addEventListener('click', () => copyText(_data?.concept,   'Concepto'));
  document.getElementById('copyAmount').addEventListener('click',  () => {
    const raw = String(_data?.amount || '');
    copyText(raw, 'Monto');
  });

  document.getElementById('reportBtn').addEventListener('click',  reportPayment);
  document.getElementById('refreshBtn').addEventListener('click', () =>
    refreshStatus().catch((e) => { document.getElementById('message').textContent = e.message; })
  );

  loadCheckout()
    .catch((err) => {
      document.getElementById('statusBar').className = 'status-bar failed';
      document.getElementById('statusBar').textContent = err.message || 'Error al cargar el pago';
    });
</script>
</body>
</html>`);
});

module.exports = router;
