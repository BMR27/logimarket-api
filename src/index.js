require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const equiposRoutes = require('./routes/equipos');
const ordersRoutes = require('./routes/orders');
const productsRoutes = require('./routes/products');
const searchRoutes = require('./routes/search');
const backpacksRoutes = require('./routes/backpacks');
const catalogsRoutes = require('./routes/catalogs');
const validacionRoutes = require('./routes/validacion');
const adminRoutes = require('./routes/admin');
const ubicacionRoutes = require('./routes/ubicacion');
const { errorHandler } = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Seguridad
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting: 200 requests por 15 minutos por IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' },
}));

app.use(express.json({ limit: '1mb' }));

// Health check (público)
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Rutas públicas
app.use('/api/auth', authRoutes);

// Rutas protegidas (requieren JWT)
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
