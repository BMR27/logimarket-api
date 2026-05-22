const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../config/database');

let sessionColumnReady = false;

async function ensureSessionColumn(pool) {
  if (sessionColumnReady) return;

  await pool.request().query(`
    IF COL_LENGTH('lm5k.Usuarios', 'sessionId') IS NULL
    BEGIN
      ALTER TABLE lm5k.Usuarios
      ADD sessionId NVARCHAR(64) NULL;
    END
  `);

  sessionColumnReady = true;
}

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autorización requerido' });
  }
  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (!payload?.idUsuario || !payload?.sessionId) {
      return res.status(401).json({ error: 'Sesión inválida. Inicia sesión nuevamente' });
    }

    const pool = await getPool();
    await ensureSessionColumn(pool);

    const result = await pool.request()
      .input('idUsuario', sql.Int, Number(payload.idUsuario))
      .query(`
        SELECT sessionId
        FROM lm5k.Usuarios
        WHERE id = @idUsuario AND ISNULL(deleted, 0) = 0
      `);

    const dbSessionId = result.recordset?.[0]?.sessionId ?? null;
    if (!dbSessionId || String(dbSessionId) !== String(payload.sessionId)) {
      return res.status(401).json({ error: 'Tu sesión se cerró porque se inició en otro dispositivo' });
    }

    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = { authenticate };
