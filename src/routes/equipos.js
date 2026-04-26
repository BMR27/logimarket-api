const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

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

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
