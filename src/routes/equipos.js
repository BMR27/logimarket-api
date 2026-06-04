const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toStringValue(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toBool(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'si' || normalized === 'sí';
  }
  return false;
}

/**
 * GET /api/equipos/:idUsuario
 * Obtiene los equipos/zonas asignados al usuario
 */
router.get('/:idUsuario', async (req, res, next) => {
  try {
    const idUsuario = parseInt(req.params.idUsuario, 10);
    if (isNaN(idUsuario)) {
      return res.status(400).json({ error: 'IdUsuario inválido' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('IdUsuario', sql.Int, idUsuario)
      .query('EXEC lm5k.spm_getEquipos @IdUsuario');

    const normalized = (result.recordset || []).map((row) => ({
      ...row,
      idEquipo: toInt(row.idEquipo ?? row.IdEquipo, 0),
      equipo: toStringValue(row.equipo ?? row.Equipo, ''),
      nomenclatura: toStringValue(row.nomenclatura ?? row.Nomenclatura, ''),
      lider: toBool(row.lider),
    }));

    res.json(normalized);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
