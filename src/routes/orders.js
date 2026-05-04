const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

let statusHistoryTableReadyPromise = null;

async function ensureOrderStatusHistoryTable(pool) {
  if (!statusHistoryTableReadyPromise) {
    statusHistoryTableReadyPromise = pool.request().query(`
      IF NOT EXISTS (
        SELECT 1 FROM sys.objects
        WHERE object_id = OBJECT_ID(N'lm5k.tb_orden_status_historial') AND type = 'U'
      )
      BEGIN
        CREATE TABLE lm5k.tb_orden_status_historial (
          id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          idOrden INT NOT NULL,
          idStatusAnterior INT NULL,
          idStatusNuevo INT NOT NULL,
          idMotivoStatus INT NULL,
          idExplicacionMotivo INT NULL,
          idUsuario INT NOT NULL,
          fechaReagenda DATETIME NULL,
          creationDate DATETIME NOT NULL DEFAULT GETDATE()
        );

        CREATE INDEX IX_tb_orden_status_historial_idOrden
          ON lm5k.tb_orden_status_historial (idOrden, creationDate DESC);
      END
    `);
  }
  await statusHistoryTableReadyPromise;
}

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
 * GET /api/orders/:id/address
 * Devuelve solo los campos de dirección de una orden directamente desde la tabla,
 * sin filtro de equipo — útil para geocodificar en el mapa del repartidor.
 */
router.get('/:id/address', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('Id', sql.Int, id)
      .query(`
        SELECT id, folioOrdenCliente,
               calle, numExterior, numInterior, colonia,
               municipioDelegacion, estado, codigoPostal,
               Latitud, Longitud
        FROM lm5k.OrdenesVenta
        WHERE id = @Id AND ISNULL(deleted, 0) = 0
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    res.json(result.recordset[0]);
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

    if (result.recordset.length) {
      return res.json(result.recordset[0]);
    }

    // Fallback: si el SP no encuentra por filtro de equipos, intentar por ID directo.
    // Esto evita falsos 404 para órdenes válidas visibles en mochila/entregas.
    const fallback = await pool.request()
      .input('Id', sql.Int, id)
      .query(`
        SELECT TOP 1
          ov.id,
          ISNULL(ov.folioOrdenCliente, '') AS folioOrdenCliente,
          ISNULL(ov.cliente, '') AS cliente,
          ISNULL(ov.telefonoPrincipal, '') AS telefonoPrincipal,
          ISNULL(ov.telefonoOpcional, '') AS telefonoOpcional,
          ISNULL(ov.codigoPostal, '') AS codigoPostal,
          ISNULL(ov.estado, '') AS estado,
          ISNULL(ov.municipioDelegacion, '') AS municipioDelegacion,
          ISNULL(ov.colonia, '') AS colonia,
          ISNULL(ov.calle, '') AS calle,
          ISNULL(ov.numExterior, '') AS numExterior,
          ISNULL(ov.numInterior, '') AS numInterior,
          ISNULL(ov.entreCalles, '') AS entreCalles,
          ISNULL(ov.referencias, '') AS referencias,
          ISNULL(ov.descripcionFachada, '') AS descripcionFachada,
          ISNULL(ov.notas, '') AS notas,
          CAST(ISNULL(ov.total, 0) AS FLOAT) AS total,
          ISNULL(ov.observacionesMensajero, '') AS observacionesMensajero,
          ISNULL(ov.idStatus, 0) AS idStatus,
          0 AS idMotivoStatus,
          0 AS idExplicacionMotivo,
          ISNULL(os.status, '') AS statusOrden,
          '' AS motivoStatus,
          '' AS explicacionMotivo,
          CONVERT(VARCHAR(19), ov.fechaPedido, 120) AS fechaPedido,
          CONVERT(VARCHAR(19), ov.fechaEntrega, 120) AS fechaEntrega,
          ov.Latitud,
          ov.Longitud,
          ov.Metros,
          ov.Tiempo
        FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
        LEFT JOIN lm5k.StatusOrdenes os WITH (NOLOCK)
          ON os.id = ov.idStatus
        WHERE ov.id = @Id
          AND ISNULL(ov.deleted, 0) = 0
      `);

    if (!fallback.recordset.length) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    res.json(fallback.recordset[0]);
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
    await ensureOrderStatusHistoryTable(pool);

    const currentOrderRes = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query('SELECT TOP 1 idStatus FROM lm5k.OrdenesVenta WHERE id = @IdOrden AND ISNULL(deleted,0)=0');

    if (!currentOrderRes.recordset.length) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const currentStatus = Number(currentOrderRes.recordset[0].idStatus || 0);

    // Regla: no se puede calificar como Intento 2 sin pasar por Intento 1.
    if (Number(status) === 6) {
      const intento1Res = await pool.request()
        .input('IdOrden', sql.Int, idOrden)
        .query(`
          SELECT TOP 1 1 AS hasIntento1
          FROM lm5k.tb_orden_status_historial
          WHERE idOrden = @IdOrden
            AND (idStatusAnterior = 5 OR idStatusNuevo = 5)
        `);

      const hasIntento1 = currentStatus === 5 || currentStatus === 6 || intento1Res.recordset.length > 0;
      if (!hasIntento1) {
        return res.status(400).json({ error: 'No puedes marcar Intento 2 sin haber pasado antes por Intento 1' });
      }
    }

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

    // Guardar historial de calificación solo cuando hay cambio real de status.
    if (currentStatus !== Number(status)) {
      await pool.request()
        .input('IdOrden', sql.Int, idOrden)
        .input('IdStatusAnterior', sql.Int, currentStatus)
        .input('IdStatusNuevo', sql.Int, Number(status))
        .input('IdMotivoStatus', sql.Int, Number(motivoStatus || 0) || null)
        .input('IdExplicacionMotivo', sql.Int, Number(explicacionMotivo || 0) || null)
        .input('IdUsuario', sql.Int, idUsuario)
        .input('FechaReagenda', sql.NVarChar(50), fechaReagenda)
        .query(`
          INSERT INTO lm5k.tb_orden_status_historial
            (idOrden, idStatusAnterior, idStatusNuevo, idMotivoStatus, idExplicacionMotivo, idUsuario, fechaReagenda, creationDate)
          VALUES
            (@IdOrden, @IdStatusAnterior, @IdStatusNuevo, @IdMotivoStatus, @IdExplicacionMotivo, @IdUsuario, TRY_CONVERT(datetime, @FechaReagenda), GETDATE())
        `);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/orders/:id/notes
 * Body: { observacionesMensajero }
 * Guarda las notas/comentarios del mensajero en la orden
 */
router.put('/:id/notes', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.id, 10);
    const { observacionesMensajero = '' } = req.body;
    if (isNaN(idOrden)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .input('Notas', sql.NVarChar(1000), observacionesMensajero)
      .query(`UPDATE lm5k.OrdenesVenta
              SET observacionesMensajero = @Notas, lastModifiedDate = GETDATE()
              WHERE id = @IdOrden`);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/orders/:id/price-request
 * Body: { precioSolicitado, motivoSolicitud, idUsuarioSolicita }
 * Crea una solicitud de cambio de precio para la orden
 */
router.post('/:id/price-request', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.id, 10);
    const { precioSolicitado, motivoSolicitud = '', idUsuarioSolicita } = req.body;
    if (isNaN(idOrden) || !precioSolicitado || !idUsuarioSolicita) {
      return res.status(400).json({ error: 'precioSolicitado e idUsuarioSolicita son requeridos' });
    }

    const pool = await getPool();

    // Cancelar solicitudes previas pendientes de esta orden
    await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query(`UPDATE lm5k.SolicitudesCambioOrden
              SET estadoSolicitud = 'cancelada', lastModifiedDate = GETDATE()
              WHERE idOrden = @IdOrden AND estadoSolicitud = 'pendiente'`);

    // Insertar nueva solicitud
    const result = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .input('IdUsuario', sql.Int, idUsuarioSolicita)
      .input('PrecioSolicitado', sql.Decimal(18, 2), precioSolicitado)
      .input('Motivo', sql.NVarChar(500), motivoSolicitud)
      .query(`INSERT INTO lm5k.SolicitudesCambioOrden
                (idOrden, idUsuarioSolicita, precioSolicitado, motivoSolicitud, estadoSolicitud, creationDate, lastModifiedDate, modifiedById, deleted)
              OUTPUT INSERTED.id
              VALUES (@IdOrden, @IdUsuario, @PrecioSolicitado, @Motivo, 'pendiente', GETDATE(), GETDATE(), @IdUsuario, 0)`);

    res.status(201).json({ success: true, id: result.recordset[0]?.id });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:id/price-request
 * Obtiene la solicitud de cambio de precio activa (pendiente o autorizada) de la orden
 */
router.get('/:id/price-request', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.id, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query(`SELECT TOP 1 id, precioSolicitado, totalAutorizado, estadoSolicitud, motivoSolicitud, creationDate
              FROM lm5k.SolicitudesCambioOrden
              WHERE idOrden = @IdOrden AND estadoSolicitud IN ('pendiente','autorizada') AND deleted = 0
              ORDER BY creationDate DESC`);

    res.json(result.recordset[0] ?? null);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/orders/:id/evidencia
 * Body: { idUsuario, nombreReceptor?, fotoBase64?, firmaBase64? }
 * Guarda o actualiza la evidencia de entrega (foto + firma) de la orden
 */
router.post('/:id/evidencia', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.id, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'ID inválido' });

    const { idUsuario, nombreReceptor = null, fotoBase64 = null, firmaBase64 = null } = req.body;
    if (!idUsuario) return res.status(400).json({ error: 'idUsuario es requerido' });

    const pool = await getPool();

    // Si ya existe un registro para esta orden, actualizarlo (upsert)
    const existing = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query(`SELECT TOP 1 id FROM lm5k.tb_entregas_evidencia WHERE idOrden = @IdOrden AND deleted = 0`);

    if (existing.recordset.length > 0) {
      const existingId = existing.recordset[0].id;
      await pool.request()
        .input('Id', sql.Int, existingId)
        .input('NombreReceptor', sql.NVarChar(200), nombreReceptor)
        .input('FotoBase64', sql.VarChar(sql.MAX), fotoBase64)
        .input('FirmaBase64', sql.VarChar(sql.MAX), firmaBase64)
        .query(`UPDATE lm5k.tb_entregas_evidencia
                SET nombreReceptor = @NombreReceptor,
                    fotoBase64 = COALESCE(@FotoBase64, fotoBase64),
                    firmaBase64 = COALESCE(@FirmaBase64, firmaBase64),
                    lastModifiedDate = GETDATE()
                WHERE id = @Id`);
      return res.json({ success: true, updated: true });
    }

    // Insertar nuevo registro
    const result = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .input('IdUsuario', sql.Int, idUsuario)
      .input('NombreReceptor', sql.NVarChar(200), nombreReceptor)
      .input('FotoBase64', sql.VarChar(sql.MAX), fotoBase64)
      .input('FirmaBase64', sql.VarChar(sql.MAX), firmaBase64)
      .query(`INSERT INTO lm5k.tb_entregas_evidencia
                (idOrden, idUsuario, nombreReceptor, fotoBase64, firmaBase64, creationDate, lastModifiedDate, deleted)
              OUTPUT INSERTED.id
              VALUES (@IdOrden, @IdUsuario, @NombreReceptor, @FotoBase64, @FirmaBase64, GETDATE(), GETDATE(), 0)`);

    res.status(201).json({ success: true, id: result.recordset[0]?.id });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:id/evidencia
 * Devuelve la evidencia de entrega guardada para la orden (si existe)
 */
router.get('/:id/evidencia', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.id, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query(`SELECT TOP 1 id, idUsuario, nombreReceptor, fotoBase64, firmaBase64, creationDate
              FROM lm5k.tb_entregas_evidencia
              WHERE idOrden = @IdOrden AND deleted = 0
              ORDER BY creationDate DESC`);

    res.json(result.recordset[0] ?? null);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:id/status-history
 * Devuelve historial de cambios de estatus de la orden
 */
router.get('/:id/status-history', async (req, res, next) => {
  try {
    const idOrden = parseInt(req.params.id, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    await ensureOrderStatusHistoryTable(pool);

    const result = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query(`
        SELECT
          h.id,
          h.idOrden,
          h.idStatusAnterior,
          h.idStatusNuevo,
          h.idMotivoStatus,
          h.idExplicacionMotivo,
          h.idUsuario,
          h.fechaReagenda,
          h.creationDate,
          sa.status AS statusAnterior,
          sn.status AS statusNuevo,
          ms.motivo AS motivoStatus,
          em.explicacion AS explicacionMotivo
        FROM lm5k.tb_orden_status_historial h
        LEFT JOIN lm5k.StatusOrdenes sa ON sa.id = h.idStatusAnterior
        LEFT JOIN lm5k.StatusOrdenes sn ON sn.id = h.idStatusNuevo
        LEFT JOIN lm5k.MotivosStatus ms ON ms.id = h.idMotivoStatus
        LEFT JOIN lm5k.ExplicacionesMotivo em ON em.id = h.idExplicacionMotivo
        WHERE h.idOrden = @IdOrden

        UNION ALL

        SELECT
          h2.idHistorial AS id,
          h2.idOrdenVenta AS idOrden,
          h2.statusAnterior AS idStatusAnterior,
          h2.statusNuevo AS idStatusNuevo,
          NULL AS idMotivoStatus,
          NULL AS idExplicacionMotivo,
          NULL AS idUsuario,
          NULL AS fechaReagenda,
          h2.fechaModificacion AS creationDate,
          sa2.status AS statusAnterior,
          sn2.status AS statusNuevo,
          h2.motivoCambio AS motivoStatus,
          NULL AS explicacionMotivo
        FROM lm5k.OrdenesVenta_StatusHistorial h2
        LEFT JOIN lm5k.StatusOrdenes sa2 ON sa2.id = h2.statusAnterior
        LEFT JOIN lm5k.StatusOrdenes sn2 ON sn2.id = h2.statusNuevo
        WHERE h2.idOrdenVenta = @IdOrden

        ORDER BY creationDate DESC, id DESC
      `);

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
