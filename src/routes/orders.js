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

    const enrichFechaReagendaFromOrdenVenta = async (baseRow) => {
      const current = (baseRow?.fechaReagendaProgramada || '').toString().trim();
      if (current) return baseRow;

      try {
        const fechaRes = await pool.request()
          .input('Id', sql.Int, id)
          .query(`
            SELECT TOP 1 CONVERT(VARCHAR(10), ov.fechaReagendaProgramada, 23) AS fechaReagendaProgramada
            FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
            WHERE ov.id = @Id AND ISNULL(ov.deleted, 0) = 0
          `);

        if (fechaRes.recordset.length) {
          return {
            ...baseRow,
            fechaReagendaProgramada: fechaRes.recordset[0].fechaReagendaProgramada || '',
          };
        }
      } catch (_) {
        // Algunos ambientes legacy usan fechaReagenda en lugar de fechaReagendaProgramada.
      }

      try {
        const fechaLegacyRes = await pool.request()
          .input('Id', sql.Int, id)
          .query(`
            SELECT TOP 1 CONVERT(VARCHAR(10), ov.fechaReagenda, 23) AS fechaReagendaProgramada
            FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
            WHERE ov.id = @Id AND ISNULL(ov.deleted, 0) = 0
          `);

        if (fechaLegacyRes.recordset.length) {
          return {
            ...baseRow,
            fechaReagendaProgramada: fechaLegacyRes.recordset[0].fechaReagendaProgramada || '',
          };
        }
      } catch (_) {
        // Si no existe ninguna columna de reagenda, no romper el flujo.
      }

      return {
        ...baseRow,
        fechaReagendaProgramada: '',
      };
    };

    const enrichMotivoFromOrdenVenta = async (baseRow) => {
      try {
        let motivoRes;
        try {
          motivoRes = await pool.request()
            .input('Id', sql.Int, id)
            .query(`
              SELECT TOP 1
                ISNULL(ov.idMotivoStatus, 0) AS idMotivoStatus,
                ISNULL(ov.idExplicacionMotivo, 0) AS idExplicacionMotivo,
                ISNULL(ms.motivo, '') AS motivoStatus,
                ISNULL(em.explicacion, '') AS explicacionMotivo,
                ISNULL(ov.observacionesMensajero, '') AS observacionesMensajero
              FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
              LEFT JOIN lm5k.MotivosStatus ms WITH (NOLOCK) ON ms.id = ov.idMotivoStatus
              LEFT JOIN lm5k.ExplicacionesMotivo em WITH (NOLOCK) ON em.id = ov.idExplicacionMotivo
              WHERE ov.id = @Id AND ISNULL(ov.deleted, 0) = 0
            `);
        } catch (_) {
          // Algunos ambientes usan el nombre plural ExplicacionesMotivos
          motivoRes = await pool.request()
            .input('Id', sql.Int, id)
            .query(`
              SELECT TOP 1
                ISNULL(ov.idMotivoStatus, 0) AS idMotivoStatus,
                ISNULL(ov.idExplicacionMotivo, 0) AS idExplicacionMotivo,
                ISNULL(ms.motivo, '') AS motivoStatus,
                ISNULL(em.explicacion, '') AS explicacionMotivo,
                ISNULL(ov.observacionesMensajero, '') AS observacionesMensajero
              FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
              LEFT JOIN lm5k.MotivosStatus ms WITH (NOLOCK) ON ms.id = ov.idMotivoStatus
              LEFT JOIN lm5k.ExplicacionesMotivos em WITH (NOLOCK) ON em.id = ov.idExplicacionMotivo
              WHERE ov.id = @Id AND ISNULL(ov.deleted, 0) = 0
            `);
        }

        if (!motivoRes.recordset.length) return baseRow;
        const m = motivoRes.recordset[0];
        return {
          ...baseRow,
          idMotivoStatus: Number(m.idMotivoStatus || 0),
          idExplicacionMotivo: Number(m.idExplicacionMotivo || 0),
          motivoStatus: m.motivoStatus || '',
          explicacionMotivo: m.explicacionMotivo || '',
          observacionesMensajero: m.observacionesMensajero || '',
        };
      } catch (err) {
        console.error('[orders/:id] enrichMotivoFromOrdenVenta fallo:', err?.message || err);
        return baseRow;
      }
    };

    if (result.recordset.length) {
      const withMotivo = await enrichMotivoFromOrdenVenta(result.recordset[0]);
      const enriched = await enrichFechaReagendaFromOrdenVenta(withMotivo);
      return res.json(enriched);
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
          ISNULL(ov.idMotivoStatus, 0) AS idMotivoStatus,
          ISNULL(ov.idExplicacionMotivo, 0) AS idExplicacionMotivo,
          ISNULL(os.status, '') AS statusOrden,
          ISNULL(ms.motivo, '') AS motivoStatus,
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
        LEFT JOIN lm5k.MotivosStatus ms WITH (NOLOCK)
          ON ms.id = ov.idMotivoStatus
        WHERE ov.id = @Id
          AND ISNULL(ov.deleted, 0) = 0
      `);

    if (!fallback.recordset.length) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const withMotivoFallback = await enrichMotivoFromOrdenVenta(fallback.recordset[0]);
    const enrichedFallback = await enrichFechaReagendaFromOrdenVenta(withMotivoFallback);
    res.json(enrichedFallback);
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

    const currentOrderRes = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query('SELECT TOP 1 idStatus FROM lm5k.OrdenesVenta WHERE id = @IdOrden AND ISNULL(deleted,0)=0');

    if (!currentOrderRes.recordset.length) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const currentStatus = Number(currentOrderRes.recordset[0].idStatus || 0);
    const safeStatus = Number(status);
    const safeMotivoStatus = Number(motivoStatus) > 0 ? Number(motivoStatus) : null;
    const safeExplicacionMotivo = Number(explicacionMotivo) > 0 ? Number(explicacionMotivo) : null;

    if ((safeStatus === 5 || safeStatus === 6) && !safeMotivoStatus) {
      return res.status(400).json({ error: 'Para Intento 1/2 el motivo es obligatorio' });
    }
    if ((safeStatus === 5 || safeStatus === 6) && !safeExplicacionMotivo) {
      return res.status(400).json({ error: 'Para Intento 1/2 la explicación es obligatoria' });
    }

    // Regla: no se puede calificar como Intento 2 sin pasar por Intento 1.
    // Verificar en historial legacy (OrdenesVenta_StatusHistorial) para no depender de tb_orden_status_historial
    if (Number(status) === 6) {
      let hasIntento1 = currentStatus === 5 || currentStatus === 6;
      if (!hasIntento1) {
        try {
          const intento1Res = await pool.request()
            .input('IdOrden', sql.Int, idOrden)
            .query(`
              SELECT TOP 1 1 AS hasIntento1
              FROM lm5k.OrdenesVenta_StatusHistorial
              WHERE idOrdenVenta = @IdOrden
                AND (statusAnterior = 5 OR statusNuevo = 5)
            `);
          hasIntento1 = intento1Res.recordset.length > 0;
        } catch (_) { /* si falla, permitir continuar */ }
      }
      if (!hasIntento1) {
        return res.status(400).json({ error: 'No puedes marcar Intento 2 sin haber pasado antes por Intento 1' });
      }
    }

    // Actualizar la orden
    let updateResult;
    try {
      updateResult = await pool.request()
        .input('Status', sql.Int, safeStatus)
        .input('MotivoStatus', sql.Int, safeMotivoStatus)
        .input('ExplicacionMotivo', sql.Int, safeExplicacionMotivo)
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
    } catch (spErr) {
      // Fallback: persistir directamente en OrdenesVenta para no bloquear guardado de motivo/status
      console.error('[spm_updateOrder] fallback update OrdenesVenta:', spErr?.message);
      const fallbackResult = await pool.request()
        .input('IdOrden', sql.Int, idOrden)
        .input('Status', sql.Int, safeStatus)
        .input('MotivoStatus', sql.Int, safeMotivoStatus)
        .query(`
          UPDATE lm5k.OrdenesVenta
          SET
            idStatus = @Status,
            idMotivoStatus = @MotivoStatus,
            lastModifiedDate = GETDATE()
          WHERE id = @IdOrden AND ISNULL(deleted, 0) = 0
        `);

      // Intentar persistir fecha de reagenda en columnas posibles del esquema.
      if (fechaReagenda) {
        try {
          await pool.request()
            .input('IdOrden', sql.Int, idOrden)
            .input('FechaReagenda', sql.NVarChar(50), fechaReagenda)
            .query(`
              UPDATE lm5k.OrdenesVenta
              SET fechaReagendaProgramada = TRY_CONVERT(date, @FechaReagenda),
                  lastModifiedDate = GETDATE()
              WHERE id = @IdOrden AND ISNULL(deleted, 0) = 0
            `);
        } catch (_) {
          try {
            await pool.request()
              .input('IdOrden', sql.Int, idOrden)
              .input('FechaReagenda', sql.NVarChar(50), fechaReagenda)
              .query(`
                UPDATE lm5k.OrdenesVenta
                SET fechaReagenda = TRY_CONVERT(datetime, @FechaReagenda),
                    lastModifiedDate = GETDATE()
                WHERE id = @IdOrden AND ISNULL(deleted, 0) = 0
              `);
          } catch (_) {
            // Columna no disponible en este ambiente.
          }
        }
      }

      // Intentar columnas opcionales sin romper el flujo si no existen en el ambiente.
      try {
        await pool.request()
          .input('IdOrden', sql.Int, idOrden)
          .input('ExplicacionMotivo', sql.Int, safeExplicacionMotivo)
          .input('IdUsuario', sql.Int, idUsuario)
          .query(`
            UPDATE lm5k.OrdenesVenta
            SET idExplicacionMotivo = @ExplicacionMotivo,
                modifiedById = @IdUsuario,
                lastModifiedDate = GETDATE()
            WHERE id = @IdOrden AND ISNULL(deleted, 0) = 0
          `);
      } catch (_) {
        // columnas no disponibles en el ambiente legacy
      }

      if (!fallbackResult.rowsAffected || fallbackResult.rowsAffected[0] === 0) {
        throw spErr;
      }

      updateResult = { recordset: [] };
    }

    const updateRow = updateResult?.recordset?.[0];
    if (updateRow && updateRow.result === 'non-affected') {
      return res.status(404).json({ error: 'Orden no encontrada o sin cambios' });
    }

    // Persistir reagenda de forma explícita en OrdenesVenta incluso si el SP no la toca.
    if (fechaReagenda) {
      try {
        await pool.request()
          .input('IdOrden', sql.Int, idOrden)
          .input('FechaReagenda', sql.NVarChar(50), fechaReagenda)
          .query(`
            UPDATE lm5k.OrdenesVenta
            SET fechaReagendaProgramada = TRY_CONVERT(date, @FechaReagenda),
                lastModifiedDate = GETDATE()
            WHERE id = @IdOrden AND ISNULL(deleted, 0) = 0
          `);
      } catch (_) {
        try {
          await pool.request()
            .input('IdOrden', sql.Int, idOrden)
            .input('FechaReagenda', sql.NVarChar(50), fechaReagenda)
            .query(`
              UPDATE lm5k.OrdenesVenta
              SET fechaReagenda = TRY_CONVERT(datetime, @FechaReagenda),
                  lastModifiedDate = GETDATE()
              WHERE id = @IdOrden AND ISNULL(deleted, 0) = 0
            `);
        } catch (_) {
          // Columna no disponible en este ambiente.
        }
      }
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
    // Envuelto en try-catch para que un fallo de permisos en tb_orden_status_historial
    // no rompa el guardado de la orden.
    if (currentStatus !== safeStatus) {
      try {
        await ensureOrderStatusHistoryTable(pool);
        await pool.request()
          .input('IdOrden', sql.Int, idOrden)
          .input('IdStatusAnterior', sql.Int, currentStatus)
          .input('IdStatusNuevo', sql.Int, safeStatus)
          .input('IdMotivoStatus', sql.Int, safeMotivoStatus)
          .input('IdExplicacionMotivo', sql.Int, safeExplicacionMotivo)
          .input('IdUsuario', sql.Int, idUsuario)
          .input('FechaReagenda', sql.NVarChar(50), fechaReagenda)
          .query(`
            INSERT INTO lm5k.tb_orden_status_historial
              (idOrden, idStatusAnterior, idStatusNuevo, idMotivoStatus, idExplicacionMotivo, idUsuario, fechaReagenda, creationDate)
            VALUES
              (@IdOrden, @IdStatusAnterior, @IdStatusNuevo, @IdMotivoStatus, @IdExplicacionMotivo, @IdUsuario, TRY_CONVERT(datetime, @FechaReagenda), GETDATE())
          `);
      } catch (histErr) {
        // No romper el flujo de guardado si falla el historial interno
        console.error('[historial-interno] error al insertar:', histErr?.message);
      }
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
    const rawId = String(req.params.id || '').trim();
    const idOrden = parseInt(rawId, 10);
    if (isNaN(idOrden)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();

    // 1) Obtener folio real de la orden por id
    const orderRes = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .query(`
        SELECT TOP 1
          ISNULL(folioOrdenCliente, '') AS folioOrdenCliente
        FROM lm5k.OrdenesVenta WITH (NOLOCK)
        WHERE ISNULL(deleted, 0) = 0 AND id = @IdOrden
      `);

    const folio = orderRes.recordset.length > 0
      ? String(orderRes.recordset[0].folioOrdenCliente || '').trim()
      : '';

    // 2) Consultar historial legacy (fuente principal) por id y folio
    const legacyResult = await pool.request()
      .input('IdOrden', sql.Int, idOrden)
      .input('Folio', sql.NVarChar(100), folio)
      .query(`
        SELECT
          h.idHistorial        AS id,
          h.idOrdenVenta       AS idOrden,
          h.statusAnterior     AS idStatusAnterior,
          h.statusNuevo        AS idStatusNuevo,
          NULL                 AS idMotivoStatus,
          NULL                 AS idExplicacionMotivo,
          NULL                 AS idUsuario,
          NULL                 AS fechaReagenda,
          h.fechaModificacion  AS creationDate,
          sa.status            AS statusAnterior,
          sn.status            AS statusNuevo,
          h.motivoCambio       AS motivoStatus,
          NULL                 AS explicacionMotivo
        FROM lm5k.OrdenesVenta_StatusHistorial h WITH (NOLOCK)
        LEFT JOIN lm5k.StatusOrdenes sa WITH (NOLOCK) ON sa.id = h.statusAnterior
        LEFT JOIN lm5k.StatusOrdenes sn WITH (NOLOCK) ON sn.id = h.statusNuevo
        WHERE h.idOrdenVenta = @IdOrden
           OR (@Folio <> '' AND h.folioOrdenCliente = @Folio)
        ORDER BY h.fechaModificacion DESC, h.idHistorial DESC
      `);

    // 3) Consultar historial nuevo solo si la tabla existe (query separado para evitar error de compilación)
    let newRows = [];
    try {
      await ensureOrderStatusHistoryTable(pool);
      const newResult = await pool.request()
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
          ORDER BY h.creationDate DESC, h.id DESC
        `);
      newRows = newResult.recordset || [];
    } catch (_) {
      // tb_orden_status_historial no disponible — solo se usa el historial legacy
    }

    // 4) Combinar, deduplicar por fecha+status y ordenar
    const combined = [...legacyResult.recordset, ...newRows];
    combined.sort((a, b) => {
      const da = new Date(a.creationDate || 0).getTime();
      const db = new Date(b.creationDate || 0).getTime();
      return db - da;
    });

    res.json(combined);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
