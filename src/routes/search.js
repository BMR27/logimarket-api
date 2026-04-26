const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

/**
 * GET /api/search
 * Query params: equipos, folio
 * Busca órdenes por folio (spm_search)
 */
router.get('/', async (req, res, next) => {
  try {
    const { equipos = '', folio = '' } = req.query;
    const pool = await getPool();
    const result = await pool.request()
      .input('equipos', sql.NVarChar(500), equipos)
      .input('folio', sql.NVarChar(100), folio)
      .query('EXEC lm5k.spm_search @equipos, @folio');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/search/backpack
 * Query params: idEquipo, folio
 * Búsqueda específica para creación de mochilas (spm_search con idEquipo)
 */
router.get('/backpack', async (req, res, next) => {
  try {
    const { idEquipo = '', folio = '' } = req.query;
    const pool = await getPool();
    const result = await pool.request()
      .input('idEquipo', sql.NVarChar(100), idEquipo)
      .input('folio', sql.NVarChar(100), folio)
      .query('EXEC lm5k.spm_search @idEquipo, @folio');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/search/repartidores
 * Query params: equipos, nombre
 * Busca repartidores por nombre (spm_search_repartidores)
 */
router.get('/repartidores', async (req, res, next) => {
  try {
    const { equipos = '', nombre = '' } = req.query;
    const pool = await getPool();
    const result = await pool.request()
      .input('equipos', sql.NVarChar(500), equipos)
      .input('nombre', sql.NVarChar(200), nombre)
      .query('EXEC lm5k.spm_search_repartidores @equipos, @nombre');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
