const express = require('express');
const { getPool } = require('../config/database');
const {
  PAYMENT_STATUS,
  ensurePaymentsSchema,
  getPaymentByProviderPaymentId,
  getPaymentByToken,
  markPaymentExpired,
  markPaymentFailed,
  markPaymentPaid,
  savePaymentEvent,
} = require('../services/payments');
const { verifyStripeWebhookEvent } = require('../services/stripe');

const router = express.Router();

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).json({ error: 'Falta firma de Stripe' });
    }

    const event = verifyStripeWebhookEvent(req.body, signature);
    const eventType = String(event.type || 'UNKNOWN');
    const eventObject = event.data?.object || {};

    const paymentToken = String(
      eventObject?.metadata?.paymentToken
      || eventObject?.payment_intent?.metadata?.paymentToken
      || ''
    ).trim();

    const providerPaymentId = String(
      eventObject?.id
      || eventObject?.checkout_session
      || ''
    ).trim();

    const pool = await getPool();
    await ensurePaymentsSchema(pool);

    let payment = null;
    if (paymentToken) {
      payment = await getPaymentByToken(pool, paymentToken);
    }
    if (!payment && providerPaymentId) {
      payment = await getPaymentByProviderPaymentId(pool, providerPaymentId);
    }

    if (!payment) {
      return res.json({ received: true, ignored: true, reason: 'payment_not_found' });
    }

    if (eventType === 'checkout.session.completed') {
      if (String(payment.status) !== PAYMENT_STATUS.PAID) {
        await markPaymentPaid(pool, payment, {
          source: 'stripe_webhook',
          eventType,
          stripeEventId: event.id,
          providerPaymentId,
        });
      }
    } else if (eventType === 'checkout.session.expired') {
      await markPaymentExpired(pool, payment.id);
      await savePaymentEvent(pool, payment.id, 'PAYMENT_EXPIRED', PAYMENT_STATUS.EXPIRED, {
        source: 'stripe_webhook',
        eventType,
        stripeEventId: event.id,
      });
    } else if (eventType === 'payment_intent.payment_failed') {
      await markPaymentFailed(pool, payment, {
        source: 'stripe_webhook',
        eventType,
        stripeEventId: event.id,
        lastPaymentError: eventObject?.last_payment_error || null,
      });
    } else {
      await savePaymentEvent(pool, payment.id, 'WEBHOOK_IGNORED', null, {
        source: 'stripe_webhook',
        eventType,
        stripeEventId: event.id,
      });
    }

    return res.json({ received: true });
  } catch (err) {
    if (err?.type === 'StripeSignatureVerificationError') {
      return res.status(400).json({ error: 'Firma de webhook invalida' });
    }
    return next(err);
  }
});

module.exports = router;
