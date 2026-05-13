const express = require('express');
const { getPool } = require('../config/database');
const {
  PAYMENT_STATUS,
  createPaymentForOrder,
  ensurePaymentsSchema,
  formatPaymentResponse,
  getLatestPaymentByOrder,
  getOrderById,
  isExpired,
  markPaymentExpired,
} = require('../services/payments');

const router = express.Router();

router.post('/:orderId/payments/generate', async (req, res, next) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'orderId invalido' });
    }

    const pool = await getPool();
    const { payment, order } = await createPaymentForOrder(pool, req, orderId);

    return res.status(201).json({
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

router.get('/:orderId/payments/status', async (req, res, next) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'orderId invalido' });
    }

    const pool = await getPool();
    await ensurePaymentsSchema(pool);

    let payment = await getLatestPaymentByOrder(pool, orderId);
    const order = await getOrderById(pool, orderId);

    if (!payment) {
      return res.status(404).json({ error: 'No existe pago para esta orden' });
    }

    if (String(payment.status) === PAYMENT_STATUS.WAITING_PAYMENT && isExpired(payment)) {
      await markPaymentExpired(pool, payment.id);
      payment = await getLatestPaymentByOrder(pool, orderId);
    }

    return res.json({
      success: true,
      payment: formatPaymentResponse(payment, order),
      canDeliver: String(payment.status) === PAYMENT_STATUS.PAID,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
