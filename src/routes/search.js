const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

// Los lectores "teclean" con distribución US; con teclado español/latinoamericano "-" llega
// como "'", "_" como "?" y "+" como "¡". Se quitan también caracteres de control (GS, CR/LF).
const normalizeFolio = (raw) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/'/g, '-')
    .replace(/\?/g, '_')
    .replace(/¡/g, '+');

// Folio completo primero (ej. "1240-253695" de PROFIT) y después sin el sufijo de
// multi-paquete que traen algunas guías externas (ej. "32452275_cb1" → "32452275").
const folioCandidates = (raw) => {
  const candidates = [normalizeFolio(raw)];
  let current = candidates[0];
  while (true) {
    const idx = Math.max(current.lastIndexOf('_'), current.lastIndexOf('-'), current.lastIndexOf('+'));
    if (idx <= 0) break;
    current = current.slice(0, idx);
    candidates.push(current);
  }
  return candidates;
};

const searchByFolio = async (pool, equipos, folio) => {
  const candidates = folio ? folioCandidates(folio) : [''];
  let recordset = [];
  for (const candidato of candidates) {
    const result = await pool.request()
      .input('equipos', sql.NVarChar(500), equipos)
      .input('folio', sql.NVarChar(100), candidato)
      .query('EXEC lm5k.spm_search @equipos, @folio');
    recordset = result.recordset;
    if (recordset.length) break;
  }
  return recordset;
};

/**
 * GET /api/search
 * Query params: equipos, folio
 * Busca órdenes por folio (spm_search)
 */
router.get('/', async (req, res, next) => {
  try {
    const { equipos = '', folio = '' } = req.query;
    const pool = await getPool();
    res.json(await searchByFolio(pool, equipos, folio));
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
    res.json(await searchByFolio(pool, idEquipo, folio));
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
