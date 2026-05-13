const express = require('express');
const { getPool } = require('../config/database');
const {
  confirmPaymentByProviderPaymentId,
  formatPaymentResponse,
  getOrderById,
  savePaymentEvent,
} = require('../services/payments');

const router = express.Router();

router.post('/:providerPaymentId/confirm', async (req, res, next) => {
  try {
    const providerPaymentId = String(req.params.providerPaymentId || '').trim();
    if (!providerPaymentId) {
      return res.status(400).json({ error: 'providerPaymentId requerido' });
    }

    const pool = await getPool();
    const payment = await confirmPaymentByProviderPaymentId(pool, providerPaymentId, {
      source: 'mock_endpoint',
      body: req.body || {},
    });

    await savePaymentEvent(pool, payment.id, 'WEBHOOK_SIMULATED', 'PAID', {
      providerPaymentId,
      source: 'POST /api/mock/payments/:providerPaymentId/confirm',
    });

    const order = await getOrderById(pool, payment.orderId);

    return res.json({
      success: true,
      payment: formatPaymentResponse(payment, order),
    });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return next(err);
  }
});

module.exports = router;
