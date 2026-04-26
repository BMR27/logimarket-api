const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

/**
 * GET /api/backpacks/:idUsuario
 * Obtiene todas las mochilas del usuario (spm_getBackpacks)
 */
router.get('/:idUsuario', async (req, res, next) => {
  try {
    const idUsuario = parseInt(req.params.idUsuario, 10);
    if (isNaN(idUsuario)) return res.status(400).json({ error: 'IdUsuario inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdUsuario', sql.Int, idUsuario)
      .query('EXEC lm5k.spm_getBackpacks @IdUsuario');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/backpacks
 * Body: { idRepartidor, idLider, orderIds (CSV string) }
 * Crea una nueva mochila (spm_insert_backpack)
 */
router.post('/', async (req, res, next) => {
  try {
    const { idRepartidor, idLider, orderIds } = req.body;
    if (!idRepartidor || !idLider || !orderIds) {
      return res.status(400).json({ error: 'idRepartidor, idLider y orderIds son requeridos' });
    }

    const fechaActual = new Date().toISOString().slice(0, 10);
    const pool = await getPool();
    const result = await pool.request()
      .input('IdRepartidor', sql.Int, idRepartidor)
      .input('IdLider', sql.Int, idLider)
      .input('FechaActual', sql.NVarChar(50), fechaActual)
      .input('OrdersIds', sql.NVarChar(sql.MAX), orderIds)
      .query('EXEC lm5k.spm_insert_backpack @IdRepartidor, @IdLider, @FechaActual, @OrdersIds');

    const row = result.recordset[0];
    if (row && row.result === 'error') {
      return res.status(500).json({ error: row.message || 'Error al crear mochila' });
    }
    res.status(201).json({ success: true, result: row });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/backpacks/:id
 * Body: { state }  (1=Asignada, 2=En Ruta, 3=Terminada, 4=Cancelada)
 * Actualiza estado de una mochila (spm_update_backpack)
 */
router.put('/:id', async (req, res, next) => {
  try {
    const idBackpack = parseInt(req.params.id, 10);
    const { state } = req.body;
    if (isNaN(idBackpack) || state === undefined) {
      return res.status(400).json({ error: 'id y state son requeridos' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('IdBackpack', sql.Int, idBackpack)
      .input('State', sql.Int, state)
      .query('EXEC lm5k.spm_update_backpack @IdBackpack, @State');

    const row = result.recordset[0];
    if (row && row.result === 'non-affected') {
      return res.status(404).json({ error: 'Mochila no encontrada' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/backpacks/:id/items
 * Obtiene ítems de una mochila (vista admin) — spm_getBackpackItemsForAdmin
 */
router.get('/:id/items', async (req, res, next) => {
  try {
    const idBackpack = parseInt(req.params.id, 10);
    if (isNaN(idBackpack)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdBackpack', sql.Int, idBackpack)
      .query('EXEC lm5k.spm_getBackpackItemsForAdmin @IdBackpack');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/backpacks/deliver/:idRepartidor/items
 * Obtiene ítems asignados al repartidor — spm_getBackpackItemsForDeliver
 */
router.get('/deliver/:idRepartidor/items', async (req, res, next) => {
  try {
    const idRepartidor = parseInt(req.params.idRepartidor, 10);
    if (isNaN(idRepartidor)) return res.status(400).json({ error: 'IdRepartidor inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdRepartidor', sql.Int, idRepartidor)
      .query('EXEC lm5k.spm_getBackpackItemsForDeliver @IdRepartidor');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/backpacks/items/:id
 * Elimina un ítem de la mochila (spm_delete_item_from_backpack)
 */
router.delete('/items/:id', async (req, res, next) => {
  try {
    const idBackpackItem = parseInt(req.params.id, 10);
    if (isNaN(idBackpackItem)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdBackpackItem', sql.Int, idBackpackItem)
      .query('EXEC lm5k.spm_delete_item_from_backpack @IdBackpackItem');

    const row = result.recordset[0];
    if (!row || row.result === false || row.result === 'false') {
      return res.status(404).json({ error: 'Ítem no encontrado' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/backpacks/items/:id/validate
 * Valida un ítem por escaneo (spm_updateBackpackItemValidation)
 */
router.put('/items/:id/validate', async (req, res, next) => {
  try {
    const idBackpackItem = parseInt(req.params.id, 10);
    if (isNaN(idBackpackItem)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdBackpackItem', sql.Int, idBackpackItem)
      .query('EXEC lm5k.spm_updateBackpackItemValidation @IdBackpackItem');

    const row = result.recordset[0];
    if (row && row.result === 'non-affected') {
      return res.status(404).json({ error: 'Ítem no encontrado' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
