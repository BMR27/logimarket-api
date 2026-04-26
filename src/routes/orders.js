const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

/**
 * GET /api/orders
 * Query params: equipos (ej: "1,2,3"), folio (opcional)
 * Usa spm_getOrdenesVenta_debug
 */
router.get('/', async (req, res, next) => {
  try {
    const { equipos = '', folio = '' } = req.query;
    const pool = await getPool();
    const result = await pool.request()
      .input('equipos', sql.NVarChar(500), equipos)
      .input('folio', sql.NVarChar(100), folio)
      .query('EXEC lm5k.spm_getOrdenesVenta_debug @equipos, @folio');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/paginated
 * Query params: equipos, folio, lastId (paginación)
 * Usa spm_getOrdenVenta
 */
router.get('/paginated', async (req, res, next) => {
  try {
    const { equipos = '', folio = '', lastId = 0 } = req.query;
    const pool = await getPool();
    const result = await pool.request()
      .input('equipos', sql.NVarChar(500), equipos)
      .input('folio', sql.NVarChar(100), folio)
      .input('lastId', sql.Int, parseInt(lastId, 10))
      .query('EXEC lm5k.spm_getOrdenVenta @equipos, @folio, @lastId');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/ways
 * Query params: equipos, folio
 * Usa spm_getOrdenVentaForWays (para mostrar en mapa)
 */
router.get('/ways', async (req, res, next) => {
  try {
    const { equipos = '', folio = '' } = req.query;
    const pool = await getPool();
    const result = await pool.request()
      .input('equipos', sql.NVarChar(500), equipos)
      .input('folio', sql.NVarChar(100), folio)
      .query('EXEC lm5k.spm_getOrdenVentaForWays @equipos, @folio');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:id
 * Query params: equipos
 * Obtiene detalle completo de una orden (spm_get_order)
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { equipos = '' } = req.query;
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('equipos', sql.NVarChar(500), equipos)
      .input('Id', sql.Int, id)
      .query('EXEC lm5k.spm_get_order @equipos, @Id');

    if (!result.recordset.length) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/orders/:id
 * Body: { status, motivoStatus, explicacionMotivo, idUsuario,
 *         fechaReagenda, latitud, longitud, metros, tiempo }
 * Actualiza estado de la orden (spm_updateOrder + spm_insertDatosEnvio)
 */
router.put('/:id', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.id, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'ID inválido' });

    const {
      status,
      motivoStatus = 0,
      explicacionMotivo = 0,
      idUsuario,
      fechaReagenda = null,
      latitud = null,
      longitud = null,
      metros = null,
      tiempo = null,
    } = req.body;

    if (status === undefined || !idUsuario) {
      return res.status(400).json({ error: 'status e idUsuario son requeridos' });
    }

    const pool = await getPool();

    // Actualizar la orden
    const updateResult = await pool.request()
      .input('Status', sql.Int, status)
      .input('MotivoStatus', sql.Int, motivoStatus)
      .input('ExplicacionMotivo', sql.Int, explicacionMotivo)
      .input('IdUsuario', sql.Int, idUsuario)
      .input('CurrentDate', sql.NVarChar(50), new Date().toISOString())
      .input('IdOrden', sql.Int, idOrden)
      .input('FechaReagenda', sql.NVarChar(50), fechaReagenda)
      .input('Latitud', sql.NVarChar(50), latitud ? String(latitud) : null)
      .input('Longitud', sql.NVarChar(50), longitud ? String(longitud) : null)
      .input('Metros', sql.NVarChar(50), metros ? String(metros) : null)
      .input('Tiempo', sql.NVarChar(50), tiempo ? String(tiempo) : null)
      .query(`EXEC lm5k.spm_updateOrder @Status, @MotivoStatus, @ExplicacionMotivo,
              @IdUsuario, @CurrentDate, @IdOrden, @FechaReagenda, @Latitud, @Longitud`);

    const updateRow = updateResult.recordset[0];
    if (updateRow && updateRow.result === 'non-affected') {
      return res.status(404).json({ error: 'Orden no encontrada o sin cambios' });
    }

    // Insertar datos de envío (distancia y tiempo)
    if (metros !== null && tiempo !== null) {
      await pool.request()
        .input('IdOrden', sql.Int, idOrden)
        .input('metros', sql.NVarChar(50), String(metros))
        .input('tiempo', sql.NVarChar(50), String(tiempo))
        .query('EXEC lm5k.spm_insertDatosEnvio @IdOrden, @metros, @tiempo');
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
