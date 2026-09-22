const sql = require('mssql');

const dbConfig = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT, 10) || 1434,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: {
    // 10 se saturaba con la carga real: cada mensajero activo manda su ubicación cada
    // 10s (location_tracking_service) y la pantalla de pagos hace polling cada 5s, y
    // cada request autenticado ya gasta una conexión solo para validar la sesión
    // (middleware/auth.js). Bajo esa carga, requests como "validar orden" quedaban en
    // cola esperando una conexión libre y el cliente Flutter (timeout de 20s) cerraba
    // el socket antes de que el servidor alcanzara a atenderla — eso es lo que se veía
    // como "request aborted" en el log y "la app no deja calificar" en el celular.
    max: 30,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  connectionTimeout: 15000,
  requestTimeout: 30000,
};

let pool = null;

async function getPool() {
  if (!pool) {
    pool = await sql.connect(dbConfig);
    console.log('✅ Conexión al pool de SQL Server establecida');
  }
  return pool;
}

module.exports = { getPool, sql };
