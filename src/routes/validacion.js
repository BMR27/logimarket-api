const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

/**
 * GET /api/validacion/sesiones
 * Retorna sesiones confirmadas para un mensajero o equipo (app móvil)
 * Query: idMensajero, idEquipo, fechaDel, fechaAl
 */
router.get('/sesiones', async (req, res, next) => {
  try {
    const { idMensajero, idEquipo, fechaDel, fechaAl } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = 'WHERE sv.confirmada = 1';
    if (idMensajero) { request.input('idMensajero', sql.Int, Number(idMensajero)); where += ' AND sv.idMensajero = @idMensajero'; }
    if (idEquipo)    { request.input('idEquipo', sql.Int, Number(idEquipo));       where += ' AND sv.idEquipo = @idEquipo'; }
    if (fechaDel)    { request.input('fechaDel', sql.Date, String(fechaDel));      where += ' AND sv.fechaDel >= @fechaDel'; }
    if (fechaAl)     { request.input('fechaAl', sql.Date, String(fechaAl));        where += ' AND sv.fechaAl <= @fechaAl'; }

    const result = await request.query(`
      SELECT
        sv.id, sv.idEquipo, e.equipo, sv.idMensajero,
        u.nombres + ' ' + u.apellidoPaterno AS mensajero,
        sv.fechaDel, sv.fechaAl, sv.totalEscaneadas,
        sv.fechaConfirmacion, sv.creationDate
      FROM lm5k.SesionesValidacion sv WITH (NOLOCK)
      INNER JOIN lm5k.Equipos e WITH (NOLOCK) ON e.id = sv.idEquipo
      INNER JOIN lm5k.Usuarios u WITH (NOLOCK) ON u.id = sv.idMensajero
      ${where}
      ORDER BY sv.fechaConfirmacion DESC
    `);

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/validacion/sesiones/:idSesion/folios
 * Retorna los folios de una sesión confirmada (app móvil)
 */
router.get('/sesiones/:idSesion/folios', async (req, res, next) => {
  try {
    const idSesion = parseInt(req.params.idSesion, 10);
    if (!idSesion) return res.status(400).json({ error: 'idSesion inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('idSesion', sql.Int, idSesion)
      .query(`
        SELECT d.folioOrdenCliente, d.idOrden, d.fechaEscaneo,
               ov.cliente, ov.municipioDelegacion AS municipio, ov.estado
        FROM lm5k.SesionValidacionDetalle d WITH (NOLOCK)
        LEFT JOIN lm5k.OrdenesVenta ov WITH (NOLOCK) ON ov.id = d.idOrden
        WHERE d.idSesion = @idSesion
        ORDER BY d.fechaEscaneo ASC
      `);

    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
