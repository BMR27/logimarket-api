require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const equiposRoutes = require('./routes/equipos');
const ordersRoutes = require('./routes/orders');
const paymentsRoutes = require('./routes/payments');
const productsRoutes = require('./routes/products');
const searchRoutes = require('./routes/search');
const backpacksRoutes = require('./routes/backpacks');
const catalogsRoutes = require('./routes/catalogs');
const validacionRoutes = require('./routes/validacion');
const adminRoutes = require('./routes/admin');
const ubicacionRoutes = require('./routes/ubicacion');
const publicPaymentsRoutes = require('./routes/publicPayments');
const mockPaymentsRoutes = require('./routes/mockPayments');
const payCheckoutRoutes = require('./routes/payCheckout');
const stripeWebhookRoutes = require('./routes/stripeWebhook');
const { errorHandler } = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const RATE_LIMIT_MAX = parsePositiveInt(process.env.RATE_LIMIT_MAX, 2000);
const AUTH_RATE_LIMIT_MAX = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 30);

// Railway y otros proxies envían X-Forwarded-For; express-rate-limit requiere trust proxy activo.
app.set('trust proxy', 1);

// Seguridad
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const rateLimitMessage = {
  error: 'Demasiadas solicitudes, intenta más tarde',
  message: 'Demasiadas solicitudes, intenta más tarde',
};

// Rate limiting global: la app móvil hace polling frecuente, así que el límite debe tolerar uso normal.
app.use(rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => (
    req.method === 'OPTIONS' ||
    req.path === '/' ||
    req.path === '/health' ||
    (req.path.startsWith('/api/') && Boolean(req.headers.authorization))
  ),
  message: rateLimitMessage,
}));

const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: rateLimitMessage,
});

// Stripe webhook requiere body crudo para validar firma antes de parsear JSON.
if (stripeWebhookRoutes) {
  app.use('/api/public/payments/stripe', stripeWebhookRoutes);
}

app.use(express.json({ limit: '1mb' }));

// Health check (público)
app.get('/', (req, res) => {
  res.json({ status: 'OK', service: 'logimarket-api' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Rutas públicas
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/public/payments', publicPaymentsRoutes);
app.use('/api/mock/payments', mockPaymentsRoutes);
app.use('/pay', payCheckoutRoutes);

// Rutas protegidas (requieren JWT)
app.use('/api/orders', authenticate, paymentsRoutes);
app.use('/api/equipos', authenticate, equiposRoutes);
app.use('/api/orders', authenticate, ordersRoutes);
app.use('/api/products', authenticate, productsRoutes);
app.use('/api/search', authenticate, searchRoutes);
app.use('/api/backpacks', authenticate, backpacksRoutes);
app.use('/api/catalogs', authenticate, catalogsRoutes);
app.use('/api/validacion', authenticate, validacionRoutes);
app.use('/api/admin', authenticate, adminRoutes);
// Ubicación en tiempo real: se expone sin auth para permitir polling del dashboard web.
app.use('/api/ubicacion', ubicacionRoutes);

// Manejo de errores
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Logimarket API corriendo en puerto ${PORT}`);
});
