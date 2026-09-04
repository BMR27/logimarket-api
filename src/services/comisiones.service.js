const { sql } = require('../config/database');

// Replica la misma prioridad de resolución de comisión por equipo usada en el
// dashboard admin (LM5K_BACKEND: cortes-equipo.controller.ts, previsualizarCorteEquipo/
// generarCorteEquipo): override por CP específico (CoberturaEquipos.comisionEquipo) >
// tarifa por tipo de cobertura del tabulador (comisionLocal/Extendida/Remota) >
// comisionFija como fallback. Es el monto que realmente gana el equipo/mensajero por
// la orden — no el total que paga el cliente.
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {Array<{id: number, idEquipo: number, codigoPostal?: string, colonia?: string, total?: number}>} ordenes
 * @returns {Promise<Map<number, {cobertura: string, comisionEquipo: number, neto: number}>>}
 */
async function calcularComisionesOrdenes(pool, ordenes) {
  const validas = ordenes.filter((o) => o && o.id != null && o.idEquipo);
  const resultado = new Map();
  if (!validas.length) return resultado;

  const request = pool.request();
  const valuesSql = validas
    .map((o, i) => {
      request.input(`id${i}`, sql.Int, o.id);
      request.input(`idEquipo${i}`, sql.Int, o.idEquipo);
      request.input(`cp${i}`, sql.NVarChar(20), o.codigoPostal || '');
      request.input(`colonia${i}`, sql.NVarChar(200), o.colonia || '');
      request.input(`total${i}`, sql.Decimal(18, 2), Number(o.total) || 0);
      return `(@id${i}, @idEquipo${i}, @cp${i}, @colonia${i}, @total${i})`;
    })
    .join(',\n');

  const query = `
    WITH Ordenes AS (
      SELECT * FROM (VALUES ${valuesSql}) AS v(id, idEquipo, codigoPostal, colonia, total)
    ),
    TabPorEquipo AS (
      SELECT idEquipo, comisionFija, comisionLocal, comisionExtendida, comisionRemota,
        ROW_NUMBER() OVER (PARTITION BY idEquipo ORDER BY id DESC) AS rn
      FROM lm5k.TabuladorEquipos
      WHERE activo = 1 AND ISNULL(deleted, 0) = 0
    )
    SELECT
      o.id,
      o.total,
      ISNULL(cob.cobertura, 'sin cobertura') AS cobertura,
      cob.comisionEquipo,
      t.comisionFija, t.comisionLocal, t.comisionExtendida, t.comisionRemota
    FROM Ordenes o
    LEFT JOIN TabPorEquipo t ON t.idEquipo = o.idEquipo AND t.rn = 1
    OUTER APPLY (
      SELECT TOP 1
        COALESCE(tco.cobertura, tc.cobertura) AS cobertura,
        COALESCE(ceo.comisionEquipo, ce.comisionEquipo) AS comisionEquipo
      FROM lm5k.CoberturaEquipos ce
      LEFT JOIN lm5k.TiposCobertura tc ON tc.id = ce.idTipoCobertura AND ISNULL(tc.deleted, 0) = 0
      OUTER APPLY (
        SELECT TOP 1 cpc.id
        FROM dbo.CodigosPostales cpc
        WHERE cpc.CodigoPostal = ce.codigoPostal
          AND LTRIM(RTRIM(cpc.Asentamiento)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(o.colonia)) COLLATE Latin1_General_CI_AI
      ) cpMatch
      LEFT JOIN lm5k.CoberturaEquipos ceo ON ceo.idCodigoPostal = cpMatch.id AND ceo.idEquipo = ce.idEquipo AND ISNULL(ceo.deleted, 0) = 0
      LEFT JOIN lm5k.TiposCobertura tco ON tco.id = ceo.idTipoCobertura AND ISNULL(tco.deleted, 0) = 0
      WHERE ce.codigoPostal = o.codigoPostal
        AND ce.idEquipo = o.idEquipo
        AND ce.idCodigoPostal IS NULL
        AND ISNULL(ce.deleted, 0) = 0
    ) cob
  `;

  const dbResult = await request.query(query);
  for (const row of dbResult.recordset) {
    const cob = String(row.cobertura ?? '').toLowerCase();
    const comEquipo = row.comisionEquipo != null ? Number(row.comisionEquipo) : null;
    const comisionFija = Number(row.comisionFija ?? 0);
    let comision;
    if (comEquipo != null && comEquipo > 0) comision = comEquipo;
    else if (cob === 'base' && row.comisionLocal != null) comision = Number(row.comisionLocal);
    else if (cob === 'extendida' && row.comisionExtendida != null) comision = Number(row.comisionExtendida);
    else if (cob === 'foranea' && row.comisionRemota != null) comision = Number(row.comisionRemota);
    else comision = comisionFija;
    comision = round2(comision);
    const total = Number(row.total) || 0;
    resultado.set(row.id, {
      cobertura: row.cobertura,
      comisionEquipo: comision,
      neto: round2(total - comision),
    });
  }
  return resultado;
}

/**
 * Aplica comisionEquipo/neto a una lista de filas de orden (mutación por copia,
 * no destructiva). Cada fila debe traer id/idEquipo/codigoPostal/colonia/total
 * (acepta variantes de casing Id/Total usadas por algunos SPs legacy).
 */
async function enrichOrdenesConComision(pool, filas) {
  const normalizadas = filas.map((f) => ({
    id: f.id ?? f.Id,
    idEquipo: f.idEquipo,
    codigoPostal: f.codigoPostal,
    colonia: f.colonia,
    total: f.total ?? f.Total,
  }));
  const comisiones = await calcularComisionesOrdenes(pool, normalizadas);
  return filas.map((f) => {
    const id = f.id ?? f.Id;
    const com = comisiones.get(id);
    if (!com) return { ...f, comisionEquipo: null };
    return { ...f, comisionEquipo: com.comisionEquipo };
  });
}

module.exports = { calcularComisionesOrdenes, enrichOrdenesConComision };
