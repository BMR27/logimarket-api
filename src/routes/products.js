const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

/**
 * GET /api/products/:idOrden
 * Obtiene productos completos de una orden (spm_getProductos)
 */
router.get('/:idOrden', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.idOrden, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'IdOrden inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query('EXEC lm5k.spm_getProductos @IdOrden');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/products/:idOrden/simple
 * Obtiene listado simple de productos (cantidad + descripción)
 * Usa spm_get_productos
 */
router.get('/:idOrden/simple', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.idOrden, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'IdOrden inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query('EXEC lm5k.spm_get_productos @IdOrden');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
