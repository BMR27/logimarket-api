const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

/**
 * GET /api/catalogs/motivos-status
 * Catálogo de motivos de status (con caché en SQLite en el cliente)
 */
router.get('/motivos-status', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT * FROM [lm5k].MotivosStatus WHERE deleted = 0');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/catalogs/explicaciones-motivo
 * Catálogo de explicaciones de motivos
 */
router.get('/explicaciones-motivo', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT * FROM [lm5k].ExplicacionesMotivos WHERE deleted = 0');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
