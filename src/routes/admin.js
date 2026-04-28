const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

/**
 * POST /api/admin/reset
 * Cancela todas las mochilas activas (State 1 o 2) y
 * resetea las órdenes asignadas a ellas de vuelta a idStatus=1 (disponibles).
 * Solo accesible por usuarios con type 'admin' o 'lider'.
 */
router.post('/reset', async (req, res, next) => {
  const userType = (req.user?.type || '').toLowerCase();
  if (userType !== 'admin' && userType !== 'lider') {
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }

  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      BEGIN TRANSACTION
        -- Capturar IDs de mochilas activas antes de cancelarlas
        DECLARE @ActiveBackpacks TABLE (Id INT)
        INSERT INTO @ActiveBackpacks
          SELECT Id FROM lm5k.tb_backpacks
          WHERE State IN (1, 2) AND Deleted = 0

        DECLARE @backpackCount INT = (SELECT COUNT(*) FROM @ActiveBackpacks)

        -- Cancelar mochilas activas
        UPDATE lm5k.tb_backpacks
          SET State = 4
          WHERE Id IN (SELECT Id FROM @ActiveBackpacks)

        -- Resetear las órdenes de esas mochilas a disponible (idStatus=1)
        DECLARE @orderCount INT
        UPDATE lm5k.OrdenesVenta
          SET idStatus = 1, idMotivoStatus = NULL
          WHERE id IN (
            SELECT cb.IdOrdenVenta
            FROM lm5k.tb_contenido_backpacks cb
            WHERE cb.IdBackPack IN (SELECT Id FROM @ActiveBackpacks)
              AND cb.Deleted = 0
          )
        SET @orderCount = @@ROWCOUNT

      COMMIT

      SELECT @backpackCount AS backpacksCancelled, @orderCount AS ordersReset
    `);

    const row = result.recordset[0];
    res.json({
      success: true,
      backpacksCancelled: row.backpacksCancelled,
      ordersReset: row.ordersReset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
