const express = require('express');
const { getPool, sql } = require('../config/database');
const { calcularComisionesOrdenes } = require('../services/comisiones.service');
const { aplicarCoordenadas, obtenerCoordenadasSeguras } = require('../services/geocodificacion.service');

const router = express.Router();

// Tope por petición: una mochila grande ronda 50-80 órdenes. calcularComisionesOrdenes usa
// 5 parámetros por orden y SQL Server admite ~2100, así que 200 deja margen de sobra.
const MAX_IDS = 200;

// Metros/Tiempo no existen en todos los ambientes; se detecta una vez por proceso.
let columnasOpcionalesPromise = null;
function columnasOpcionales(pool) {
  if (!columnasOpcionalesPromise) {
    columnasOpcionalesPromise = pool.request().query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'lm5k' AND TABLE_NAME = 'OrdenesVenta' AND COLUMN_NAME IN ('Metros', 'Tiempo')
    `).then((r) => new Set(r.recordset.map((x) => String(x.COLUMN_NAME))))
      .catch((err) => {
        columnasOpcionalesPromise = null;
        throw err;
      });
  }
  return columnasOpcionalesPromise;
}

/**
 * POST /api/orders/batch
 * Body: { ids: number[], equipos: "1,2,3" }
 * Devuelve el detalle de varias órdenes en una sola respuesta, con las mismas llaves que
 * GET /api/orders/:id (SP spm_get_order + motivo + reagenda + comisión + coordenadas).
 * Sustituye las N peticiones por orden que hacía la app al cargar la mochila: con 80+
 * mensajeros eso eran miles de conexiones simultáneas desde datos móviles.
 * Respuesta: { orders: [...], missing: [ids que no existen o están borradas] }
 */
router.post('/', async (req, res, next) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    const equipos = String(req.body?.equipos ?? '').trim();
    if (!ids.length) return res.json({ orders: [], missing: [] });
    if (ids.length > MAX_IDS) {
      return res.status(400).json({ error: `Máximo ${MAX_IDS} órdenes por petición` });
    }

    const pool = await getPool();
    const [opcionales, coords] = await Promise.all([
      columnasOpcionales(pool),
      obtenerCoordenadasSeguras(pool, ids),
    ]);
    const metrosSelect = opcionales.has('Metros') ? 'ov.Metros' : 'NULL AS Metros';
    const tiempoSelect = opcionales.has('Tiempo') ? 'ov.Tiempo' : 'NULL AS Tiempo';

    const result = await pool.request()
      .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(ids))
      .input('equipos', sql.NVarChar(500), equipos)
      .query(`
        DECLARE @EquiposTbl TABLE (Id INT PRIMARY KEY);
        INSERT INTO @EquiposTbl (Id)
        SELECT DISTINCT TRY_CAST(value AS INT) FROM STRING_SPLIT(@equipos, ',')
        WHERE TRY_CAST(value AS INT) IS NOT NULL;

        SELECT
          ov.id AS Id,
          ISNULL(ov.folioOrdenCliente, '') AS folioOrdenCliente,
          -- Mismo formato que spm_get_order cuando la orden es de los equipos del
          -- mensajero; el respaldo por ID de GET /:id regresa el nombre tal cual.
          CASE
            WHEN eq.Id IS NOT NULL AND ov.telefonoOpcional IS NOT NULL
              THEN ov.cliente + ' | Código: ' + ov.telefonoOpcional
            ELSE ISNULL(ov.cliente, '')
          END AS Cliente,
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
          CAST(ISNULL(ov.total, 0) AS FLOAT) AS Total,
          ISNULL(ov.idStatus, 0) AS idStatus,
          ISNULL(os.status, '') AS statusOrden,
          ISNULL(ov.idMotivoStatus, 0) AS idMotivoStatus,
          ISNULL(ov.idExplicacionMotivo, 0) AS idExplicacionMotivo,
          ISNULL(ms.motivo, '') AS motivoStatus,
          ISNULL(em.explicacion, '') AS explicacionMotivo,
          ISNULL(ov.observacionesMensajero, '') AS observacionesMensajero,
          ISNULL(CONVERT(VARCHAR(10), ov.fechaReagendaProgramada, 23), '') AS fechaReagendaProgramada,
          CONVERT(VARCHAR(19), ov.fechaPedido, 120) AS fechaPedido,
          CONVERT(VARCHAR(19), ov.fechaEntrega, 120) AS fechaEntrega,
          de.CodigoPostal AS codigoPostalOrigen,
          ov.idEquipo,
          ${metrosSelect},
          ${tiempoSelect}
        FROM OPENJSON(@ids) j
        INNER JOIN lm5k.OrdenesVenta ov WITH (NOLOCK)
          ON ov.id = CAST(j.value AS INT) AND ISNULL(ov.deleted, 0) = 0
        LEFT JOIN @EquiposTbl eq ON eq.Id = ov.idEquipo
        LEFT JOIN lm5k.tb_DireccionEquipos de WITH (NOLOCK) ON de.IdEquipo = ov.idEquipo
        LEFT JOIN lm5k.StatusOrdenes os WITH (NOLOCK) ON os.id = ov.idStatus
        LEFT JOIN lm5k.MotivosStatus ms WITH (NOLOCK) ON ms.id = ov.idMotivoStatus
        LEFT JOIN lm5k.ExplicacionesMotivos em WITH (NOLOCK) ON em.id = ov.idExplicacionMotivo;
      `);

    // tb_DireccionEquipos podría traer más de un renglón por equipo: una orden, un renglón.
    const porId = new Map();
    for (const row of result.recordset) {
      if (!porId.has(row.Id)) porId.set(row.Id, row);
    }
    const rows = [...porId.values()];

    let comisiones = new Map();
    try {
      comisiones = await calcularComisionesOrdenes(pool, rows.map((r) => ({
        id: r.Id,
        idEquipo: r.idEquipo,
        codigoPostal: r.codigoPostal,
        colonia: r.colonia,
        total: r.Total,
      })));
    } catch (err) {
      console.error('[orders/batch] comisiones fallo:', err?.message || err);
    }

    const orders = rows.map((r) => {
      const { idEquipo, ...row } = r;
      const com = comisiones.get(r.Id);
      return { ...row, comisionEquipo: com ? com.comisionEquipo : null };
    });
    aplicarCoordenadas(orders, coords, { idKey: (r) => r.Id });

    res.json({ orders, missing: ids.filter((id) => !porId.has(id)) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
