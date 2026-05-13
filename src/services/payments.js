const crypto = require('crypto');
const { sql } = require('../config/database');

let schemaReadyPromise = null;

const PAYMENT_STATUS = {
  WAITING_PAYMENT: 'WAITING_PAYMENT',
  PAID: 'PAID',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

function paymentProvider() {
  return process.env.PAYMENT_PROVIDER || 'KLU_MOCK';
}

function isBankTransferProvider(provider) {
  const normalized = String(provider || '').toUpperCase();
  return normalized === 'KLU_BANK_TRANSFER' || normalized === 'KLU_MANUAL_TRANSFER';
}

function getPaymentDestinationAccount() {
  return String(process.env.PAYMENT_DESTINATION_ACCOUNT || '').trim();
}

function buildManualTransferReference(payment) {
  const token = String(payment?.paymentToken || payment?.id || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  return `TRF-${token.slice(0, 12)}`;
}

function buildManualTransferDetails(payment, order, reference) {
  const destinationAccount = getPaymentDestinationAccount();
  const amount = Number(payment?.amount || 0);
  const currency = payment?.currency || 'MXN';
  const trackingNumber = order?.trackingNumber || payment?.orderId || payment?.paymentToken || '';
  const concept = `Pago orden ${trackingNumber}`;
  const transferReference = reference || buildManualTransferReference(payment);

  return {
    destinationAccount,
    reference: transferReference,
    amount,
    currency,
    concept,
    instructions: [
      `Transfiere ${amount.toFixed(2)} ${currency} a la cuenta ${destinationAccount}.`,
      `Usa la referencia ${transferReference}.`,
      'Cuando el banco confirme el movimiento, el pago podrá marcarse como recibido.',
    ],
  };
}

function paymentExpiryMinutes() {
  const parsed = Number(process.env.PAYMENT_EXPIRY_MINUTES || 30);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function paymentCommissionRate() {
  const parsed = Number(process.env.PAYMENT_COMMISSION_RATE || 0.03);
  if (!Number.isFinite(parsed) || parsed < 0) return 0.03;
  return parsed;
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch (_) {
    return null;
  }
}

function roundMoney(value) {
  const n = Number(value || 0);
  return Math.round(n * 100) / 100;
}

function qrCodeUrlFor(checkoutUrl) {
  const encoded = encodeURIComponent(checkoutUrl);
  return `https://quickchart.io/qr?size=360&text=${encoded}`;
}

function getCheckoutBaseUrl(req) {
  if (process.env.PUBLIC_CHECKOUT_BASE_URL) {
    return process.env.PUBLIC_CHECKOUT_BASE_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.get('host');
  return `${proto}://${host}`;
}

function maskCustomerName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts
    .map((part, idx) => {
      if (part.length <= 1) return '*';
      if (idx === 0) return `${part[0]}${'*'.repeat(Math.max(part.length - 1, 1))}`;
      return `${part[0]}${'*'.repeat(Math.max(part.length - 2, 1))}${part[part.length - 1]}`;
    })
    .join(' ');
}

async function ensurePaymentsSchema(pool) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = pool.request().query(`
      IF NOT EXISTS (
        SELECT 1
        FROM sys.objects
        WHERE object_id = OBJECT_ID(N'lm5k.payments') AND type = 'U'
      )
      BEGIN
        CREATE TABLE lm5k.payments (
          id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          orderId INT NOT NULL,
          provider NVARCHAR(50) NOT NULL,
          providerPaymentId NVARCHAR(120) NULL,
          paymentToken NVARCHAR(120) NOT NULL,
          amount DECIMAL(18,2) NOT NULL,
          currency NVARCHAR(10) NOT NULL,
          commissionAmount DECIMAL(18,2) NOT NULL,
          netAmount DECIMAL(18,2) NOT NULL,
          checkoutUrl NVARCHAR(500) NOT NULL,
          qrCodeUrl NVARCHAR(1000) NULL,
          status NVARCHAR(30) NOT NULL,
          expiresAt DATETIME2 NOT NULL,
          paidAt DATETIME2 NULL,
          creationDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          lastModifiedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          deleted BIT NOT NULL DEFAULT 0
        );

        CREATE UNIQUE INDEX UX_payments_paymentToken
          ON lm5k.payments(paymentToken);

        CREATE INDEX IX_payments_order_status
          ON lm5k.payments(orderId, status, creationDate DESC);
      END

      IF NOT EXISTS (
        SELECT 1
        FROM sys.objects
        WHERE object_id = OBJECT_ID(N'lm5k.payment_events') AND type = 'U'
      )
      BEGIN
        CREATE TABLE lm5k.payment_events (
          id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          paymentId INT NOT NULL,
          eventType NVARCHAR(50) NOT NULL,
          providerStatus NVARCHAR(50) NULL,
          payload NVARCHAR(MAX) NULL,
          createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );

        CREATE INDEX IX_payment_events_paymentId
          ON lm5k.payment_events(paymentId, createdAt DESC);
      END

      IF COL_LENGTH('lm5k.payments', 'creationDate') IS NULL
        ALTER TABLE lm5k.payments ADD creationDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();

      IF COL_LENGTH('lm5k.payments', 'lastModifiedDate') IS NULL
        ALTER TABLE lm5k.payments ADD lastModifiedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();

      IF COL_LENGTH('lm5k.payments', 'createdAt') IS NULL
        ALTER TABLE lm5k.payments ADD createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();

      IF COL_LENGTH('lm5k.payments', 'updatedAt') IS NULL
        ALTER TABLE lm5k.payments ADD updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();

      IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'lm5k.payments')
          AND name = 'IX_payments_order_status'
      )
      BEGIN
        CREATE INDEX IX_payments_order_status
          ON lm5k.payments(orderId, status, creationDate DESC);
      END
    `);
  }
  await schemaReadyPromise;
}

async function getOrderById(pool, orderId) {
  const result = await pool.request()
    .input('OrderId', sql.Int, Number(orderId))
    .query(`
      SELECT TOP 1
        ov.id,
        ISNULL(ov.folioOrdenCliente, '') AS trackingNumber,
        ISNULL(ov.cliente, '') AS customerName,
        CAST(ISNULL(ov.total, 0) AS DECIMAL(18,2)) AS amount,
        ISNULL(ov.idStatus, 0) AS orderStatus
      FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
      WHERE ov.id = @OrderId
    `);

  return result.recordset?.[0] || null;
}

async function getPaymentByToken(pool, paymentToken) {
  const result = await pool.request()
    .input('PaymentToken', sql.NVarChar(120), paymentToken)
    .query(`
      SELECT TOP 1 *
      FROM lm5k.payments
      WHERE paymentToken = @PaymentToken
        AND deleted = 0
      ORDER BY id DESC
    `);

  return result.recordset?.[0] || null;
}

async function getLatestPaymentByOrder(pool, orderId) {
  const result = await pool.request()
    .input('OrderId', sql.Int, Number(orderId))
    .query(`
      SELECT TOP 1 *
      FROM lm5k.payments
      WHERE orderId = @OrderId
        AND deleted = 0
      ORDER BY creationDate DESC, id DESC
    `);

  return result.recordset?.[0] || null;
}

async function setOrderPaymentFlags(pool, orderId, paymentStatus, deliveryStatus) {
  const columnsResult = await pool.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'lm5k'
      AND TABLE_NAME = 'OrdenesVenta'
      AND COLUMN_NAME IN ('paymentStatus', 'deliveryStatus', 'lastModifiedDate')
  `);

  const columns = new Set((columnsResult.recordset || []).map((r) => String(r.COLUMN_NAME || '')));
  const sets = [];
  if (columns.has('paymentStatus')) sets.push('paymentStatus = @PaymentStatus');
  if (columns.has('deliveryStatus')) sets.push('deliveryStatus = @DeliveryStatus');
  if (columns.has('lastModifiedDate')) sets.push('lastModifiedDate = GETDATE()');

  if (sets.length === 0) return;

  await pool.request()
    .input('OrderId', sql.Int, Number(orderId))
    .input('PaymentStatus', sql.NVarChar(30), paymentStatus)
    .input('DeliveryStatus', sql.NVarChar(40), deliveryStatus)
    .query(`
      UPDATE lm5k.OrdenesVenta
      SET ${sets.join(', ')}
      WHERE id = @OrderId
    `);
}

function formatPaymentResponse(payment, order, opts = {}) {
  const status = String(payment.status || PAYMENT_STATUS.WAITING_PAYMENT);
  const bankTransfer = isBankTransferProvider(payment.provider)
    ? buildManualTransferDetails(payment, order, payment.providerPaymentId || null)
    : null;

  return {
    id: Number(payment.id),
    orderId: Number(payment.orderId),
    trackingNumber: order?.trackingNumber || '',
    customerName: opts.maskCustomer ? maskCustomerName(order?.customerName || '') : (order?.customerName || ''),
    amount: Number(payment.amount),
    currency: payment.currency || 'MXN',
    provider: payment.provider || paymentProvider(),
    providerPaymentId: payment.providerPaymentId || null,
    paymentToken: payment.paymentToken,
    checkoutUrl: payment.checkoutUrl,
    qrCodeUrl: payment.qrCodeUrl,
    bankTransfer,
    paymentStatus: status,
    status,
    expiresAt: toIso(payment.expiresAt),
    paidAt: toIso(payment.paidAt),
    availableMethods: ['CARD', 'SPEI', 'CASH_MOCK'],
    canPay: status === PAYMENT_STATUS.WAITING_PAYMENT,
    isExpired: status === PAYMENT_STATUS.EXPIRED,
  };
}

function isExpired(payment) {
  if (!payment?.expiresAt) return false;
  return new Date(payment.expiresAt).getTime() <= Date.now();
}

async function markPaymentExpired(pool, paymentId) {
  await pool.request()
    .input('PaymentId', sql.Int, Number(paymentId))
    .query(`
      UPDATE lm5k.payments
      SET status = '${PAYMENT_STATUS.EXPIRED}',
          lastModifiedDate = SYSUTCDATETIME()
      WHERE id = @PaymentId
        AND status = '${PAYMENT_STATUS.WAITING_PAYMENT}'
    `);
}

async function createPaymentForOrder(pool, req, orderId) {
  await ensurePaymentsSchema(pool);

  const order = await getOrderById(pool, orderId);
  if (!order) {
    const err = new Error('Orden no encontrada');
    err.statusCode = 404;
    throw err;
  }

  const previous = await getLatestPaymentByOrder(pool, orderId);
  if (previous && String(previous.status) === PAYMENT_STATUS.WAITING_PAYMENT && !isExpired(previous)) {
    return { payment: previous, order };
  }

  if (previous && String(previous.status) === PAYMENT_STATUS.WAITING_PAYMENT && isExpired(previous)) {
    await markPaymentExpired(pool, previous.id);
  }

  const provider = paymentProvider();
  const token = crypto.randomUUID();
  const base = getCheckoutBaseUrl(req);
  const checkoutUrl = `${base}/pay/${token}`;
  const qrCodeUrl = qrCodeUrlFor(checkoutUrl);
  const amount = roundMoney(order.amount);
  const commissionAmount = roundMoney(amount * paymentCommissionRate());
  const netAmount = roundMoney(amount - commissionAmount);

  const insertResult = await pool.request()
    .input('OrderId', sql.Int, Number(orderId))
    .input('Provider', sql.NVarChar(50), provider)
    .input('PaymentToken', sql.NVarChar(120), token)
    .input('Amount', sql.Decimal(18, 2), amount)
    .input('Currency', sql.NVarChar(10), 'MXN')
    .input('CommissionAmount', sql.Decimal(18, 2), commissionAmount)
    .input('NetAmount', sql.Decimal(18, 2), netAmount)
    .input('CheckoutUrl', sql.NVarChar(500), checkoutUrl)
    .input('QrCodeUrl', sql.NVarChar(1000), qrCodeUrl)
    .input('ExpiresAt', sql.DateTime2, new Date(Date.now() + paymentExpiryMinutes() * 60000))
    .query(`
      INSERT INTO lm5k.payments
        (orderId, provider, paymentToken, amount, currency, commissionAmount, netAmount, checkoutUrl, qrCodeUrl, status, expiresAt, creationDate, lastModifiedDate, deleted)
      OUTPUT INSERTED.*
      VALUES
        (@OrderId, @Provider, @PaymentToken, @Amount, @Currency, @CommissionAmount, @NetAmount, @CheckoutUrl, @QrCodeUrl, '${PAYMENT_STATUS.WAITING_PAYMENT}', @ExpiresAt, SYSUTCDATETIME(), SYSUTCDATETIME(), 0)
    `);

  const payment = insertResult.recordset?.[0];

  await setOrderPaymentFlags(pool, orderId, PAYMENT_STATUS.WAITING_PAYMENT, 'WAITING_PAYMENT');

  return { payment, order };
}

async function savePaymentEvent(pool, paymentId, eventType, providerStatus, payload) {
  await pool.request()
    .input('PaymentId', sql.Int, Number(paymentId))
    .input('EventType', sql.NVarChar(50), String(eventType || 'UNKNOWN'))
    .input('ProviderStatus', sql.NVarChar(50), providerStatus ? String(providerStatus) : null)
    .input('Payload', sql.NVarChar(sql.MAX), payload ? JSON.stringify(payload) : null)
    .query(`
      INSERT INTO lm5k.payment_events (paymentId, eventType, providerStatus, payload, createdAt)
      VALUES (@PaymentId, @EventType, @ProviderStatus, @Payload, SYSUTCDATETIME())
    `);
}

async function markPaymentPaid(pool, payment, payload) {
  if (!payment) return null;

  await pool.request()
    .input('PaymentId', sql.Int, Number(payment.id))
    .query(`
      UPDATE lm5k.payments
      SET status = '${PAYMENT_STATUS.PAID}',
          paidAt = SYSUTCDATETIME(),
          lastModifiedDate = SYSUTCDATETIME()
      WHERE id = @PaymentId
    `);

  await savePaymentEvent(pool, payment.id, 'PAYMENT_CONFIRMED', PAYMENT_STATUS.PAID, payload || {});
  await setOrderPaymentFlags(pool, payment.orderId, PAYMENT_STATUS.PAID, 'PAYMENT_CONFIRMED');

  const refreshed = await pool.request()
    .input('PaymentId', sql.Int, Number(payment.id))
    .query('SELECT TOP 1 * FROM lm5k.payments WHERE id = @PaymentId');

  return refreshed.recordset?.[0] || null;
}

async function markPaymentFailed(pool, payment, payload) {
  if (!payment) return null;

  await pool.request()
    .input('PaymentId', sql.Int, Number(payment.id))
    .query(`
      UPDATE lm5k.payments
      SET status = '${PAYMENT_STATUS.FAILED}',
          lastModifiedDate = SYSUTCDATETIME()
      WHERE id = @PaymentId
    `);

  await savePaymentEvent(pool, payment.id, 'PAYMENT_FAILED', PAYMENT_STATUS.FAILED, payload || {});

  const refreshed = await pool.request()
    .input('PaymentId', sql.Int, Number(payment.id))
    .query('SELECT TOP 1 * FROM lm5k.payments WHERE id = @PaymentId');

  return refreshed.recordset?.[0] || null;
}

async function setProviderPaymentId(pool, paymentId, providerPaymentId) {
  const result = await pool.request()
    .input('PaymentId', sql.Int, Number(paymentId))
    .input('ProviderPaymentId', sql.NVarChar(120), providerPaymentId)
    .query(`
      UPDATE lm5k.payments
      SET providerPaymentId = @ProviderPaymentId,
          lastModifiedDate = SYSUTCDATETIME()
      WHERE id = @PaymentId;

      SELECT TOP 1 *
      FROM lm5k.payments
      WHERE id = @PaymentId
    `);

  return result.recordset?.[0] || null;
}

async function confirmPaymentByProviderPaymentId(pool, providerPaymentId, payload) {
  await ensurePaymentsSchema(pool);

  const paymentResult = await pool.request()
    .input('ProviderPaymentId', sql.NVarChar(120), providerPaymentId)
    .query(`
      SELECT TOP 1 *
      FROM lm5k.payments
      WHERE providerPaymentId = @ProviderPaymentId
        AND deleted = 0
      ORDER BY id DESC
    `);

  const payment = paymentResult.recordset?.[0] || null;
  if (!payment) {
    const err = new Error('Pago no encontrado');
    err.statusCode = 404;
    throw err;
  }

  if (String(payment.status) === PAYMENT_STATUS.PAID) {
    return payment;
  }

  if (String(payment.status) === PAYMENT_STATUS.EXPIRED) {
    const err = new Error('El pago ya expiro');
    err.statusCode = 409;
    throw err;
  }

  return markPaymentPaid(pool, payment, payload || { source: 'mock_confirm' });
}

async function scheduleMockConfirmation(confirmFn, providerPaymentId) {
  const delayMs = Math.max(2000, Number(process.env.PAYMENT_MOCK_CONFIRM_MS || 4000));
  setTimeout(() => {
    confirmFn(providerPaymentId).catch((err) => {
      console.error('[payments] mock auto-confirm failed:', err?.message || err);
    });
  }, delayMs);
}

module.exports = {
  PAYMENT_STATUS,
  buildManualTransferDetails,
  buildManualTransferReference,
  createPaymentForOrder,
  ensurePaymentsSchema,
  formatPaymentResponse,
  confirmPaymentByProviderPaymentId,
  getLatestPaymentByOrder,
  getOrderById,
  getPaymentByToken,
  getPaymentDestinationAccount,
  isExpired,
  markPaymentExpired,
  markPaymentFailed,
  markPaymentPaid,
  maskCustomerName,
  paymentProvider,
  isBankTransferProvider,
  qrCodeUrlFor,
  savePaymentEvent,
  scheduleMockConfirmation,
  setProviderPaymentId,
};