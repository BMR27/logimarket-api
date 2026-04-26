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
    max: 10,
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
