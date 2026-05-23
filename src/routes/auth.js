const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID, createHash } = require('crypto');
const { getPool, sql } = require('../config/database');

const router = express.Router();

let sessionColumnReady = false;

function resolveDeviceId(rawDeviceId, req) {
  const normalized = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';
  if (normalized) return normalized;

  const userAgent = req.get('user-agent') || 'unknown';
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const fingerprint = createHash('sha256')
    .update(`${userAgent}|${ip}`)
    .digest('hex')
    .slice(0, 32);

  return `fallback-${fingerprint}`;
}

async function ensureSessionColumn(pool) {
  if (sessionColumnReady) return;

  await pool.request().query(`
    IF COL_LENGTH('lm5k.Usuarios', 'sessionId') IS NULL
    BEGIN
      ALTER TABLE lm5k.Usuarios
      ADD sessionId NVARCHAR(64) NULL;
    END

    IF COL_LENGTH('lm5k.Usuarios', 'sessionDeviceId') IS NULL
    BEGIN
      ALTER TABLE lm5k.Usuarios
      ADD sessionDeviceId NVARCHAR(128) NULL;
    END

    IF COL_LENGTH('lm5k.Usuarios', 'sessionUpdatedAt') IS NULL
    BEGIN
      ALTER TABLE lm5k.Usuarios
      ADD sessionUpdatedAt DATETIME NULL;
    END
  `);

  sessionColumnReady = true;
}

/**
 * POST /api/auth/login
 * Body: { correo, password }
 * Returns: { token, user }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { correo, password, deviceId, forceLogin } = req.body || {};
    if (!correo || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }
    const resolvedDeviceId = resolveDeviceId(deviceId, req);

    const pool = await getPool();
    const result = await pool.request()
      .input('correo', sql.NVarChar(200), correo)
      .input('pass', sql.NVarChar(200), password)
      .query('EXEC lm5k.spm_login @correo, @pass');

    if (!result.recordset || result.recordset.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const row = result.recordset[0];
    switch (row.response) {
      case 'SUCCESS': {
        await ensureSessionColumn(pool);

        const sessionCheck = await pool.request()
          .input('idUsuario', sql.Int, row.idUsuario)
          .query(`
            SELECT sessionId, sessionDeviceId, sessionUpdatedAt
            FROM lm5k.Usuarios
            WHERE id = @idUsuario
          `);

        const existing = sessionCheck.recordset?.[0] || null;
        const existingSessionId = existing?.sessionId ? String(existing.sessionId) : '';
        const existingDeviceId = existing?.sessionDeviceId ? String(existing.sessionDeviceId) : '';

        const shouldForceLogin = forceLogin === true || String(forceLogin).toLowerCase() === 'true';
        if (!shouldForceLogin && existingSessionId && existingDeviceId && existingDeviceId !== resolvedDeviceId) {
          return res.status(409).json({
            error: 'Ya existe una sesión activa para este usuario. ¿Deseas cerrar la anterior y activar esta?',
            code: 'ACTIVE_SESSION_ON_OTHER_DEVICE',
          });
        }

        const sessionId = randomUUID();
        await pool.request()
          .input('idUsuario', sql.Int, row.idUsuario)
          .input('sessionId', sql.NVarChar(64), sessionId)
          .input('sessionDeviceId', sql.NVarChar(128), resolvedDeviceId)
          .query(`
            UPDATE lm5k.Usuarios
            SET sessionId = @sessionId
              , sessionDeviceId = @sessionDeviceId
              , sessionUpdatedAt = GETDATE()
            WHERE id = @idUsuario
          `);

        const user = {
          idUsuario: row.idUsuario,
          correo: row.correo,
          nombres: row.nombres,
          apellidoPaterno: row.apellidoPaterno,
          apellidoMaterno: row.apellidoMaterno,
          type: row.origin,
          sessionId,
        };
        const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token, user });
      }
      case 'INVALID_CREDENTIALS':
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      case 'INVALID_ROL':
        return res.status(403).json({ error: 'El rol de su usuario no tiene permiso de acceso' });
      case 'INVALID_USER':
        return res.status(403).json({ error: 'Usuario deshabilitado' });
      default:
        return res.status(401).json({ error: 'Error de autenticación' });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/version
 * Verifica si la versión de la app es válida
 */
router.get('/version', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('EXEC lm5k.spm_getAppVersion');
    res.json(result.recordset[0] || {});
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Header: Authorization: Bearer <token>
 */
router.post('/logout', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autorización requerido' });
    }

    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.idUsuario || !payload?.sessionId) {
      return res.status(401).json({ error: 'Sesión inválida' });
    }

    const pool = await getPool();
    await ensureSessionColumn(pool);

    await pool.request()
      .input('idUsuario', sql.Int, Number(payload.idUsuario))
      .input('sessionId', sql.NVarChar(64), String(payload.sessionId))
      .query(`
        UPDATE lm5k.Usuarios
        SET
          sessionId = NULL,
          sessionDeviceId = NULL,
          sessionUpdatedAt = NULL
        WHERE id = @idUsuario
          AND sessionId = @sessionId
      `);

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
