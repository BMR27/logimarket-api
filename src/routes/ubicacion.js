const express = require('express');
const { getPool, sql } = require('../config/database');
const { armarRecorrido, puntoMasCercano, distanciaM, limpiarPuntos, PRECISION_MAX_M } = require('../services/recorrido.service');

const router = express.Router();

// ── Lazy migration: tabla de ubicación en tiempo real ────────────────────────
let ubicacionTableReady = null;
async function ensureUbicacionTable(pool) {
  if (!ubicacionTableReady) {
    ubicacionTableReady = pool.request().query(`
      IF NOT EXISTS (
        SELECT 1 FROM sys.objects
        WHERE object_id = OBJECT_ID(N'lm5k.tb_mensajero_ubicacion') AND type = 'U'
      )
      CREATE TABLE lm5k.tb_mensajero_ubicacion (
        id          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        idMensajero INT NOT NULL,
        idOrden     INT NULL,
        latitud     DECIMAL(10,7) NOT NULL,
        longitud    DECIMAL(10,7) NOT NULL,
        accuracy    FLOAT NULL,
        enViaje     BIT NOT NULL DEFAULT 0,
        updatedAt   DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_mensajero_ubicacion UNIQUE (idMensajero)
      );
    `);
  }
  await ubicacionTableReady;
}

// ── Lazy migration: tabla de historial de ubicaciones ────────────────────────
let historyTableReady = null;
async function ensureHistoryTable(pool) {
  if (!historyTableReady) {
    historyTableReady = (async () => {
      await pool.request().query(`
        IF NOT EXISTS (
          SELECT 1 FROM sys.objects
          WHERE object_id = OBJECT_ID(N'lm5k.tb_mensajero_ubicacion_history') AND type = 'U'
        )
        CREATE TABLE lm5k.tb_mensajero_ubicacion_history (
          id          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          idMensajero INT NOT NULL,
          idOrden     INT NULL,
          latitud     DECIMAL(10,7) NOT NULL,
          longitud    DECIMAL(10,7) NOT NULL,
          accuracy    FLOAT NULL,
          enViaje     BIT NOT NULL DEFAULT 0,
          createdAt   DATETIME NOT NULL DEFAULT GETDATE()
        );
      `);
      await pool.request().query(`
        IF NOT EXISTS (
          SELECT 1 FROM sys.indexes
          WHERE object_id = OBJECT_ID(N'lm5k.tb_mensajero_ubicacion_history')
            AND name = 'IX_hist_mensajero_created'
        )
        CREATE INDEX IX_hist_mensajero_created
          ON lm5k.tb_mensajero_ubicacion_history(idMensajero, createdAt DESC);
      `);
    })();
  }
  await historyTableReady;
}

// ── Lazy migration: columnas para diagnóstico del rastreo ────────────────────
// velocidad (m/s) en el historial; permiso/plataforma/versión de la app en la
// posición actual, para saber desde la web por qué un celular manda pocos puntos.
let columnasRastreoReady = null;
async function ensureColumnasRastreo(pool) {
  if (!columnasRastreoReady) {
    columnasRastreoReady = (async () => {
      await ensureUbicacionTable(pool);
      await ensureHistoryTable(pool);
      await pool.request().query(`
        IF COL_LENGTH('lm5k.tb_mensajero_ubicacion_history', 'velocidad') IS NULL
          ALTER TABLE lm5k.tb_mensajero_ubicacion_history ADD velocidad FLOAT NULL;
        IF COL_LENGTH('lm5k.tb_mensajero_ubicacion', 'permiso') IS NULL
          ALTER TABLE lm5k.tb_mensajero_ubicacion ADD permiso NVARCHAR(20) NULL;
        IF COL_LENGTH('lm5k.tb_mensajero_ubicacion', 'plataforma') IS NULL
          ALTER TABLE lm5k.tb_mensajero_ubicacion ADD plataforma NVARCHAR(10) NULL;
        IF COL_LENGTH('lm5k.tb_mensajero_ubicacion', 'appVersion') IS NULL
          ALTER TABLE lm5k.tb_mensajero_ubicacion ADD appVersion NVARCHAR(20) NULL;
      `);
    })().catch((err) => {
      columnasRastreoReady = null;
      throw err;
    });
  }
  await columnasRastreoReady;
}

// Las fechas de estas tablas se guardan con GETDATE() (hora local del servidor,
// México) sin zona horaria; mssql las entrega como si fueran UTC. Para no
// mezclar zonas, los tiempos del recorrido se manejan en "hora de reloj local
// expresada como ms UTC" y la web los formatea con timeZone 'UTC'.
const relojMs = (d) => (d instanceof Date ? d.getTime() : Date.parse(d));

const texto = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * POST /api/ubicacion
 * Formato de siempre (un punto): { idMensajero, latitud, longitud, accuracy?, idOrden?, enViaje? }
 * Formato por lote (app 2.2+):   { idMensajero, idOrden?, enViaje?, permiso?, plataforma?, appVersion?,
 *                                  puntos: [{ latitud, longitud, accuracy?, velocidad?, capturadoEn (epoch ms) }] }
 * El lote permite que el celular junte puntos sin señal y los mande después.
 */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const idMensajero = Number(body.idMensajero);
    const ahora = Date.now();
    const crudos = Array.isArray(body.puntos) ? body.puntos : [body];
    const puntos = crudos
      .map((p) => ({
        lat: Number(p?.latitud),
        lng: Number(p?.longitud),
        accuracy: p?.accuracy != null && Number.isFinite(Number(p.accuracy)) ? Number(p.accuracy) : null,
        velocidad: p?.velocidad != null && Number.isFinite(Number(p.velocidad)) ? Number(p.velocidad) : null,
        capturado: Number(p?.capturadoEn) || ahora,
      }))
      // Sin coordenada válida, o con fecha fuera de lo razonable (reloj del celular mal)
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat !== 0 && p.lng !== 0
        && p.capturado > ahora - 48 * 3600 * 1000 && p.capturado < ahora + 2 * 60 * 1000)
      .sort((x, y) => x.capturado - y.capturado)
      .slice(-500);
    if (!idMensajero || !puntos.length) {
      return res.status(400).json({ message: 'idMensajero y al menos un punto con latitud/longitud son requeridos' });
    }

    const pool = await getPool();
    await ensureColumnasRastreo(pool);

    const idOrden = body.idOrden ? Number(body.idOrden) : null;
    const enViaje = body.enViaje ? 1 : 0;
    const segundosAtras = (p) => Math.max(0, Math.round((ahora - p.capturado) / 1000));
    const ultimo = puntos[puntos.length - 1];

    await pool.request()
      .input('idMensajero', sql.Int, idMensajero)
      .input('idOrden', sql.Int, idOrden)
      .input('latitud', sql.Decimal(10, 7), ultimo.lat)
      .input('longitud', sql.Decimal(10, 7), ultimo.lng)
      .input('accuracy', sql.Float, ultimo.accuracy)
      .input('enViaje', sql.Bit, enViaje)
      .input('atras', sql.Int, segundosAtras(ultimo))
      .input('permiso', sql.NVarChar(20), texto(body.permiso, 20))
      .input('plataforma', sql.NVarChar(10), texto(body.plataforma, 10))
      .input('appVersion', sql.NVarChar(20), texto(body.appVersion, 20))
      .query(`
        MERGE lm5k.tb_mensajero_ubicacion AS target
        USING (SELECT @idMensajero AS idMensajero) AS source
        ON target.idMensajero = source.idMensajero
        WHEN MATCHED THEN
          UPDATE SET
            latitud    = @latitud,
            longitud   = @longitud,
            accuracy   = @accuracy,
            idOrden    = @idOrden,
            enViaje    = @enViaje,
            updatedAt  = DATEADD(SECOND, -@atras, GETDATE()),
            permiso    = COALESCE(@permiso, target.permiso),
            plataforma = COALESCE(@plataforma, target.plataforma),
            appVersion = COALESCE(@appVersion, target.appVersion)
        WHEN NOT MATCHED THEN
          INSERT (idMensajero, latitud, longitud, accuracy, idOrden, enViaje, updatedAt, permiso, plataforma, appVersion)
          VALUES (@idMensajero, @latitud, @longitud, @accuracy, @idOrden, @enViaje,
                  DATEADD(SECOND, -@atras, GETDATE()), @permiso, @plataforma, @appVersion);
      `);

    // Historial: solo puntos con precisión útil para dibujar el trayecto. Se
    // espera a que se guarde para que la app sepa si puede borrar su cola.
    const utiles = puntos.filter((p) => p.accuracy == null || p.accuracy <= PRECISION_MAX_M * 1.5);
    for (let i = 0; i < utiles.length; i += 200) {
      const bloque = utiles.slice(i, i + 200);
      const request = pool.request()
        .input('hIdMensajero', sql.Int, idMensajero)
        .input('hIdOrden', sql.Int, idOrden)
        .input('hEnViaje', sql.Bit, enViaje);
      const valores = bloque.map((p, k) => {
        request.input(`la${k}`, sql.Decimal(10, 7), p.lat);
        request.input(`lo${k}`, sql.Decimal(10, 7), p.lng);
        request.input(`ac${k}`, sql.Float, p.accuracy);
        request.input(`ve${k}`, sql.Float, p.velocidad);
        request.input(`at${k}`, sql.Int, segundosAtras(p));
        return `(@hIdMensajero, @hIdOrden, @la${k}, @lo${k}, @ac${k}, @ve${k}, @hEnViaje, DATEADD(SECOND, -@at${k}, GETDATE()))`;
      });
      await request.query(`
        INSERT INTO lm5k.tb_mensajero_ubicacion_history
          (idMensajero, idOrden, latitud, longitud, accuracy, velocidad, enViaje, createdAt)
        VALUES ${valores.join(',\n')}
      `);
    }

    res.json({ ok: true, recibidos: puntos.length, guardados: utiles.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ubicacion/todos?equipos=1,2
 * Última posición de todos los mensajeros (opcionalmente solo de esos equipos)
 * en una sola consulta; la web ya no pide mensajero por mensajero.
 * segundosDesde se calcula en la base para no depender de la zona horaria.
 * IMPORTANTE: debe estar ANTES de /:idMensajero.
 */
router.get('/todos', async (req, res, next) => {
  try {
    const equipos = String(req.query.equipos || '')
      .split(',').map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0).slice(0, 200);
    const pool = await getPool();
    await ensureColumnasRastreo(pool);

    const result = await pool.request().query(`
      SELECT u.idMensajero,
             LTRIM(RTRIM(ISNULL(usr.nombres, '') + ' ' + ISNULL(usr.apellidoPaterno, ''))) AS mensajero,
             u.latitud, u.longitud, u.accuracy, u.idOrden, u.enViaje,
             u.updatedAt,
             DATEDIFF(SECOND, u.updatedAt, GETDATE()) AS segundosDesde,
             u.permiso, u.plataforma, u.appVersion,
             eq.id AS idEquipo, eq.equipo,
             ov.folioOrdenCliente, ov.cliente, ov.calle, ov.colonia
      FROM lm5k.tb_mensajero_ubicacion u WITH (NOLOCK)
      INNER JOIN lm5k.Usuarios usr WITH (NOLOCK) ON usr.id = u.idMensajero AND ISNULL(usr.deleted, 0) = 0
      OUTER APPLY (
        SELECT TOP 1 e.id, e.equipo
        FROM lm5k.UsuariosEquipo ue WITH (NOLOCK)
        INNER JOIN lm5k.Equipos e WITH (NOLOCK) ON e.id = ue.idEquipo AND ISNULL(e.deleted, 0) = 0
        WHERE ue.idUsuario = u.idMensajero AND ISNULL(ue.deleted, 0) = 0
        ${equipos.length ? `AND ue.idEquipo IN (${equipos.join(',')})` : ''}
        ORDER BY ue.id DESC
      ) eq
      LEFT JOIN lm5k.OrdenesVenta ov WITH (NOLOCK) ON ov.id = u.idOrden AND ISNULL(ov.deleted, 0) = 0
      ${equipos.length ? 'WHERE eq.id IS NOT NULL' : ''}
      ORDER BY u.updatedAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ubicacion/:idMensajero/recorrido?fecha=YYYY-MM-DD
 * Recorrido del día: tramos simplificados [[lat, lng, t], ...], huecos sin
 * señal, paradas, entregas (cambios de estatus desde la app) y resumen.
 * `t` es hora de reloj local en ms (formatear con timeZone 'UTC').
 * IMPORTANTE: debe estar ANTES de /:idMensajero.
 */
router.get('/:idMensajero/recorrido', async (req, res, next) => {
  try {
    const idMensajero = Number(req.params.idMensajero);
    if (!idMensajero) return res.status(400).json({ message: 'idMensajero inválido' });
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || '')) ? String(req.query.fecha) : null;

    const pool = await getPool();
    await ensureHistoryTable(pool);

    const dia = await pool.request()
      .input('fecha', sql.Date, fecha)
      .input('idMensajero', sql.Int, idMensajero)
      .query(`
        SELECT CONVERT(VARCHAR(10), ISNULL(@fecha, CAST(GETDATE() AS DATE)), 23) AS fecha,
               (SELECT LTRIM(RTRIM(ISNULL(nombres, '') + ' ' + ISNULL(apellidoPaterno, '')))
                FROM lm5k.Usuarios WHERE id = @idMensajero) AS mensajero
      `);
    const fechaDia = dia.recordset[0].fecha;

    const [pts, eventos] = await Promise.all([
      pool.request()
        .input('idMensajero', sql.Int, idMensajero)
        .input('fecha', sql.Date, fechaDia)
        .query(`
          SELECT TOP 20000 latitud, longitud, accuracy, createdAt
          FROM lm5k.tb_mensajero_ubicacion_history WITH (NOLOCK)
          WHERE idMensajero = @idMensajero
            AND createdAt >= @fecha AND createdAt < DATEADD(DAY, 1, @fecha)
          ORDER BY createdAt
        `),
      pool.request()
        .input('idMensajero', sql.Int, idMensajero)
        .input('fecha', sql.Date, fechaDia)
        .query(`
          IF OBJECT_ID(N'lm5k.tb_orden_status_historial') IS NOT NULL
          SELECT h.id, h.idOrden, h.idStatusNuevo, so.status, h.creationDate,
                 ov.folioOrdenCliente, ov.cliente, ov.calle, ov.numExterior, ov.colonia,
                 g.latitud AS destinoLat, g.longitud AS destinoLng, g.nivelPrecision
          FROM lm5k.tb_orden_status_historial h WITH (NOLOCK)
          LEFT JOIN lm5k.StatusOrdenes so WITH (NOLOCK) ON so.id = h.idStatusNuevo
          LEFT JOIN lm5k.OrdenesVenta ov WITH (NOLOCK) ON ov.id = h.idOrden
          LEFT JOIN lm5k.OrdenesVentaGeocodificacion g WITH (NOLOCK) ON g.idOrden = h.idOrden
          WHERE h.idUsuario = @idMensajero
            AND h.creationDate >= @fecha AND h.creationDate < DATEADD(DAY, 1, @fecha)
          ORDER BY h.creationDate
        `).catch((err) => {
          console.error('[recorrido] eventos:', err?.message);
          return { recordset: [] };
        }),
    ]);

    const crudos = (pts.recordset || []).map((r) => ({
      lat: Number(r.latitud),
      lng: Number(r.longitud),
      accuracy: r.accuracy != null ? Number(r.accuracy) : null,
      t: relojMs(r.createdAt),
    }));
    const recorrido = armarRecorrido(crudos);
    const validos = limpiarPuntos(crudos);

    const entregas = (eventos.recordset || []).map((e) => {
      const t = relojMs(e.creationDate);
      const marcado = puntoMasCercano(validos, t);
      const destino = e.destinoLat != null ? { lat: Number(e.destinoLat), lng: Number(e.destinoLng) } : null;
      return {
        idOrden: e.idOrden,
        folio: e.folioOrdenCliente,
        cliente: e.cliente,
        direccion: [[e.calle, e.numExterior].filter(Boolean).join(' '), e.colonia].filter(Boolean).join(', '),
        idStatus: e.idStatusNuevo,
        status: e.status,
        t,
        destino,
        precisionDestino: e.nivelPrecision,
        // Dónde estaba el celular al marcar la orden (punto GPS más cercano en el tiempo)
        marcado: marcado ? { lat: marcado.lat, lng: marcado.lng } : null,
        distanciaDestinoM: marcado && destino ? Math.round(distanciaM(marcado, destino)) : null,
      };
    });

    res.json({
      idMensajero,
      mensajero: dia.recordset[0].mensajero,
      fecha: fechaDia,
      ...recorrido,
      entregas,
      resumen: {
        ...recorrido.resumen,
        entregas: entregas.filter((e) => e.idStatus === 1).length,
        intentos: entregas.filter((e) => e.idStatus === 5 || e.idStatus === 6).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ubicacion/equipo/:idEquipo
 * Retorna la última posición conocida de todos los mensajeros del equipo.
 * IMPORTANTE: debe estar ANTES de /:idMensajero para que Express no lo capture antes.
 */
router.get('/equipo/:idEquipo', async (req, res, next) => {
  try {
    const idEquipo = Number(req.params.idEquipo);
    if (!idEquipo || Number.isNaN(idEquipo)) {
      return res.status(400).json({ message: 'idEquipo inválido' });
    }
    const pool = await getPool();
    await ensureUbicacionTable(pool);

    const result = await pool.request()
      .input('idEquipo', sql.Int, idEquipo)
      .query(`
        SELECT u.idMensajero,
               ISNULL(usr.nombres + ' ' + usr.apellidoPaterno, '') AS mensajero,
               u.latitud, u.longitud, u.accuracy, u.idOrden, u.enViaje,
               u.updatedAt,
               ov.folioOrdenCliente,
               ov.cliente,
               ov.calle,
               ov.colonia
        FROM lm5k.tb_mensajero_ubicacion u WITH (NOLOCK)
        INNER JOIN lm5k.Usuarios usr WITH (NOLOCK)
          ON usr.id = u.idMensajero
        INNER JOIN lm5k.UsuariosEquipo ue WITH (NOLOCK)
          ON ue.idUsuario = u.idMensajero AND ue.idEquipo = @idEquipo
             AND ISNULL(ue.deleted, 0) = 0
        LEFT JOIN lm5k.OrdenesVenta ov WITH (NOLOCK)
          ON ov.id = u.idOrden AND ISNULL(ov.deleted, 0) = 0
        WHERE ISNULL(usr.deleted, 0) = 0
        ORDER BY u.updatedAt DESC
      `);

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ubicacion/:idMensajero/history?limit=50
 * Retorna las últimas N posiciones históricas del mensajero.
 * IMPORTANTE: debe estar ANTES de /:idMensajero.
 */
router.get('/:idMensajero/history', async (req, res, next) => {
  try {
    const idMensajero = Number(req.params.idMensajero);
    if (!idMensajero || Number.isNaN(idMensajero)) {
      return res.status(400).json({ message: 'idMensajero inválido' });
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const pool = await getPool();
    await ensureHistoryTable(pool);

    const result = await pool.request()
      .input('idMensajero', sql.Int, idMensajero)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          h.id, h.idMensajero, h.latitud, h.longitud, h.accuracy,
          h.enViaje, h.idOrden, h.createdAt,
          ov.folioOrdenCliente
        FROM lm5k.tb_mensajero_ubicacion_history h WITH (NOLOCK)
        LEFT JOIN lm5k.OrdenesVenta ov WITH (NOLOCK)
          ON ov.id = h.idOrden AND ISNULL(ov.deleted, 0) = 0
        WHERE h.idMensajero = @idMensajero
        ORDER BY h.createdAt DESC
      `);

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ubicacion/:idMensajero
 * Retorna la última posición conocida de un mensajero.
 */
router.get('/:idMensajero', async (req, res, next) => {
  try {
    const idMensajero = Number(req.params.idMensajero);
    if (!idMensajero || Number.isNaN(idMensajero)) {
      return res.status(400).json({ message: 'idMensajero inválido' });
    }
    const pool = await getPool();
    await ensureUbicacionTable(pool);

    const result = await pool.request()
      .input('idMensajero', sql.Int, idMensajero)
      .query(`
        SELECT u.idMensajero,
               ISNULL(usr.nombres + ' ' + usr.apellidoPaterno, '') AS mensajero,
               u.latitud, u.longitud, u.accuracy, u.idOrden, u.enViaje,
               u.updatedAt,
               ov.folioOrdenCliente,
               ov.cliente,
               ov.calle,
               ov.colonia
        FROM lm5k.tb_mensajero_ubicacion u WITH (NOLOCK)
        LEFT JOIN lm5k.Usuarios usr WITH (NOLOCK) ON usr.id = u.idMensajero
        LEFT JOIN lm5k.OrdenesVenta ov WITH (NOLOCK)
          ON ov.id = u.idOrden AND ISNULL(ov.deleted, 0) = 0
        WHERE u.idMensajero = @idMensajero
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ message: 'Sin ubicación registrada para este mensajero' });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/ubicacion/:idMensajero
 * Borra la ubicación en tiempo real del mensajero (al cerrar sesión / detener tracking).
 */
router.delete('/:idMensajero', async (req, res, next) => {
  try {
    const idMensajero = Number(req.params.idMensajero);
    if (!idMensajero || Number.isNaN(idMensajero)) {
      return res.status(400).json({ message: 'idMensajero inválido' });
    }
    const pool = await getPool();
    await ensureUbicacionTable(pool);
    await pool.request()
      .input('idMensajero', sql.Int, idMensajero)
      .query(`DELETE FROM lm5k.tb_mensajero_ubicacion WHERE idMensajero = @idMensajero`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
