const express = require('express');
const { getPool, sql } = require('../config/database');

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

/**
 * POST /api/ubicacion
 * Body: { idMensajero, latitud, longitud, accuracy?, idOrden?, enViaje? }
 * La app del mensajero llama a este endpoint cada ~10 s para actualizar su posición.
 */
router.post('/', async (req, res, next) => {
  try {
    const { idMensajero, latitud, longitud, accuracy, idOrden, enViaje } = req.body;
    if (!idMensajero || latitud == null || longitud == null) {
      return res.status(400).json({ message: 'idMensajero, latitud y longitud son requeridos' });
    }
    const pool = await getPool();
    await ensureUbicacionTable(pool);

    await pool.request()
      .input('idMensajero', sql.Int, Number(idMensajero))
      .input('idOrden', sql.Int, idOrden ? Number(idOrden) : null)
      .input('latitud', sql.Decimal(10, 7), Number(latitud))
      .input('longitud', sql.Decimal(10, 7), Number(longitud))
      .input('accuracy', sql.Float, accuracy != null ? Number(accuracy) : null)
      .input('enViaje', sql.Bit, enViaje ? 1 : 0)
      .query(`
        MERGE lm5k.tb_mensajero_ubicacion AS target
        USING (SELECT @idMensajero AS idMensajero) AS source
        ON target.idMensajero = source.idMensajero
        WHEN MATCHED THEN
          UPDATE SET
            latitud   = @latitud,
            longitud  = @longitud,
            accuracy  = @accuracy,
            idOrden   = @idOrden,
            enViaje   = @enViaje,
            updatedAt = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (idMensajero, latitud, longitud, accuracy, idOrden, enViaje)
          VALUES (@idMensajero, @latitud, @longitud, @accuracy, @idOrden, @enViaje);
      `);

    res.json({ ok: true });
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

module.exports = router;
