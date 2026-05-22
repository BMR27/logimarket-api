const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { getPool, sql } = require('../config/database');

const router = express.Router();

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

/**
 * POST /api/auth/login
 * Body: { correo, password }
 * Returns: { token, user }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { correo, password } = req.body;
    if (!correo || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

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

        const sessionId = randomUUID();
        await pool.request()
          .input('idUsuario', sql.Int, row.idUsuario)
          .input('sessionId', sql.NVarChar(64), sessionId)
          .query(`
            UPDATE lm5k.Usuarios
            SET sessionId = @sessionId
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

module.exports = router;
