const crypto = require('crypto');
const express = require('express');
const { getPool } = require('../config/database');
const {
  PAYMENT_STATUS,
  buildManualTransferDetails,
  confirmPaymentByProviderPaymentId,
  ensurePaymentsSchema,
  formatPaymentResponse,
  getOrderById,
  getPaymentByToken,
  isExpired,
  markPaymentExpired,
  markPaymentFailed,
  markPaymentPaid,
  markPaymentUnderReview,
  paymentProvider,
  savePaymentEvent,
  scheduleMockConfirmation,
  setProviderPaymentId,
} = require('../services/payments');

const router = express.Router();

async function resolvePayment(pool, paymentToken) {
  await ensurePaymentsSchema(pool);
  let payment = await getPaymentByToken(pool, paymentToken);
  if (!payment) return null;

  if (String(payment.status) === PAYMENT_STATUS.WAITING_PAYMENT && isExpired(payment)) {
    await markPaymentExpired(pool, payment.id);
    payment = await getPaymentByToken(pool, paymentToken);
  }

  return payment;
}

async function confirmMockPayment(providerPaymentId) {
  const pool = await getPool();
  return confirmPaymentByProviderPaymentId(pool, providerPaymentId, {
    source: 'auto_mock',
  });
}

router.get('/:paymentToken', async (req, res, next) => {
  try {
    const paymentToken = String(req.params.paymentToken || '').trim();
    if (!paymentToken) {
      return res.status(400).json({ error: 'paymentToken requerido' });
    }

    const pool = await getPool();
    const payment = await resolvePayment(pool, paymentToken);
    if (!payment) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const order = await getOrderById(pool, payment.orderId);
    const status = String(payment.status);
    const bankTransfer = buildManualTransferDetails(payment, order, payment.providerPaymentId || null);

    return res.json({
      success: true,
      paymentToken: payment.paymentToken,
      trackingNumber: order?.trackingNumber || '',
      customerName: order?.customerName || '',
      customerCode: String(order?.customerCode || ''),
      amount: Number(payment.amount),
      currency: payment.currency || 'MXN',
      bankName: bankTransfer.bankName,
      beneficiaryName: bankTransfer.beneficiaryName,
      clabe: bankTransfer.clabe,
      reference: bankTransfer.reference,
      concept: bankTransfer.concept,
      status,
      expiresAt: payment.expiresAt,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:paymentToken/status', async (req, res, next) => {
  try {
    const paymentToken = String(req.params.paymentToken || '').trim();
    if (!paymentToken) {
      return res.status(400).json({ error: 'paymentToken requerido' });
    }

    const pool = await getPool();
    const payment = await resolvePayment(pool, paymentToken);
    if (!payment) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    return res.json({
      success: true,
      status: String(payment.status),
      paymentStatus: String(payment.status),
      paidAt: payment.paidAt,
      expiresAt: payment.expiresAt,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:paymentToken/pay', async (req, res, next) => {
  try {
    const paymentToken = String(req.params.paymentToken || '').trim();
    if (!paymentToken) {
      return res.status(400).json({ error: 'paymentToken requerido' });
    }

    const pool = await getPool();
    let payment = await resolvePayment(pool, paymentToken);
    if (!payment) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    if (String(payment.status) === PAYMENT_STATUS.PAID) {
      return res.status(409).json({ error: 'El pago ya fue confirmado' });
    }

    if (String(payment.status) === PAYMENT_STATUS.EXPIRED) {
      return res.status(409).json({ error: 'El pago expiro' });
    }

    if (String(payment.status) !== PAYMENT_STATUS.WAITING_PAYMENT) {
      return res.status(409).json({ error: `El pago no esta disponible: ${payment.status}` });
    }

    const provider = paymentProvider();
    if (isBankTransferProvider(provider)) {
      const order = await getOrderById(pool, payment.orderId);
      const transferReference = payment.providerPaymentId || buildManualTransferReference(payment);
      const bankTransfer = buildManualTransferDetails(payment, order, transferReference);

      if (!payment.providerPaymentId) {
        payment = await setProviderPaymentId(pool, payment.id, bankTransfer.reference);
      }

      await savePaymentEvent(pool, payment.id, 'MANUAL_TRANSFER_INSTRUCTIONS', PAYMENT_STATUS.WAITING_PAYMENT, {
        provider,
        bankTransfer,
      });

      const paymentResponse = formatPaymentResponse(payment, order);
      paymentResponse.bankTransfer = bankTransfer;

      return res.json({
        success: true,
        provider,
        status: String(payment.status),
        paymentStatus: String(payment.status),
        providerPaymentId: payment.providerPaymentId,
        bankTransfer,
        payment: paymentResponse,
        message: 'Transfiere manualmente a la cuenta indicada y conserva la referencia.',
      });
    }

    if (!payment.providerPaymentId) {
      const providerPaymentId = `mock_${crypto.randomUUID().replace(/-/g, '')}`;
      payment = await setProviderPaymentId(pool, payment.id, providerPaymentId);
      await savePaymentEvent(pool, payment.id, 'PAYMENT_STARTED', 'WAITING_PROVIDER', {
        provider,
        providerPaymentId,
      });
      scheduleMockConfirmation(confirmMockPayment, providerPaymentId);
    }

    const paymentUrl = `${payment.checkoutUrl}?providerPaymentId=${encodeURIComponent(payment.providerPaymentId)}`;

    return res.json({
      success: true,
      provider,
      status: String(payment.status),
      providerPaymentId: payment.providerPaymentId,
      paymentUrl,
      qrCodeUrl: payment.qrCodeUrl,
      payment: formatPaymentResponse(payment, await getOrderById(pool, payment.orderId)),
      message: provider === 'KLU_MOCK'
        ? 'Pago en simulacion, espera confirmacion.'
        : 'Pago iniciado.',
    });
  } catch (err) {
    return next(err);
  }
});

// ── Reporte de pago por el cliente ────────────────────────────────────────
router.post('/:paymentToken/report-payment', async (req, res, next) => {
  try {
    const paymentToken = String(req.params.paymentToken || '').trim();
    if (!paymentToken) {
      return res.status(400).json({ error: 'paymentToken requerido' });
    }

    const pool = await getPool();
    const payment = await resolvePayment(pool, paymentToken);
    if (!payment) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const currentStatus = String(payment.status);

    if (currentStatus === PAYMENT_STATUS.PAID) {
      return res.status(409).json({ error: 'El pago ya fue confirmado' });
    }
    if (currentStatus === PAYMENT_STATUS.EXPIRED) {
      return res.status(409).json({ error: 'El pago ha expirado' });
    }
    if (currentStatus === PAYMENT_STATUS.CANCELLED) {
      return res.status(409).json({ error: 'El pago fue cancelado' });
    }
    if (
      currentStatus === PAYMENT_STATUS.UNDER_REVIEW ||
      currentStatus === PAYMENT_STATUS.CUSTOMER_REPORTED_PAYMENT
    ) {
      return res.json({
        success: true,
        status: currentStatus,
        message: 'Pago ya reportado. Finanzas validará la transferencia.',
      });
    }

    const updated = await markPaymentUnderReview(pool, payment.id);
    await savePaymentEvent(pool, payment.id, 'CUSTOMER_REPORTED_PAYMENT', PAYMENT_STATUS.UNDER_REVIEW, {
      source: 'customer_checkout',
    });

    return res.json({
      success: true,
      status: updated?.status || PAYMENT_STATUS.UNDER_REVIEW,
      message: 'Pago reportado correctamente. Finanzas validará la transferencia.',
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
