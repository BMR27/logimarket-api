const Stripe = require('stripe');

let stripeClient = null;

function isStripeProvider(provider) {
  return String(provider || '').trim().toUpperCase() === 'STRIPE';
}

function stripeApiVersion() {
  return process.env.STRIPE_API_VERSION || '2025-04-30.basil';
}

function stripeCurrency() {
  return String(process.env.PAYMENT_CURRENCY || 'MXN').trim().toLowerCase();
}

function getStripeClient() {
  if (!stripeClient) {
    const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
    if (!secretKey) {
      const err = new Error('Falta STRIPE_SECRET_KEY en variables de entorno');
      err.statusCode = 500;
      throw err;
    }
    stripeClient = new Stripe(secretKey, { apiVersion: stripeApiVersion() });
  }
  return stripeClient;
}

function asStripeAmount(amount) {
  const n = Number(amount || 0);
  return Math.max(0, Math.round(n * 100));
}

async function createStripeCheckoutSession({
  paymentToken,
  orderId,
  amount,
  currency,
  trackingNumber,
  customerName,
  successUrl,
  cancelUrl,
}) {
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    payment_method_types: ['card'],
    metadata: {
      paymentToken: String(paymentToken || ''),
      orderId: String(orderId || ''),
      trackingNumber: String(trackingNumber || ''),
    },
    payment_intent_data: {
      metadata: {
        paymentToken: String(paymentToken || ''),
        orderId: String(orderId || ''),
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: String(currency || stripeCurrency()).toLowerCase(),
          product_data: {
            name: `Pago entrega ${trackingNumber || orderId}`,
            description: customerName ? `Cliente: ${customerName}` : undefined,
          },
          unit_amount: asStripeAmount(amount),
        },
      },
    ],
  });

  if (!session?.id || !session?.url) {
    const err = new Error('Stripe no devolvio una sesion valida');
    err.statusCode = 502;
    throw err;
  }

  return {
    id: session.id,
    url: session.url,
  };
}

function verifyStripeWebhookEvent(rawBody, signature) {
  const stripe = getStripeClient();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) {
    const err = new Error('Falta STRIPE_WEBHOOK_SECRET en variables de entorno');
    err.statusCode = 500;
    throw err;
  }
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

module.exports = {
  createStripeCheckoutSession,
  getStripeClient,
  isStripeProvider,
  stripeCurrency,
  verifyStripeWebhookEvent,
};
