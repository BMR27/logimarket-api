const { sql } = require('../config/database');

// lm5k.OrdenesVenta no tiene latitud/longitud: la app geocodificaba cada orden en
// cada celular y en cada sesión (lento y con costo en Google). Aquí se guarda el
// punto ya validado contra el CP para que se calcule una sola vez.
//
// huellaDireccion es un hash de los campos de dirección al momento de guardar;
// si alguien edita la dirección de la orden, la huella ya no coincide, el punto
// se ignora y la app vuelve a geocodificar y a guardar.
//
// precision: 'direccion' = se encontró la calle/colonia dentro del CP;
//            'cp'        = sin coincidencia confiable, se usó el centro del CP.

let tableReadyPromise = null;

function huellaDireccionSql(alias) {
  return `CONVERT(VARCHAR(40), HASHBYTES('SHA1', CONCAT(
    ${alias}.calle, N'|', ${alias}.numExterior, N'|', ${alias}.colonia, N'|',
    ${alias}.municipioDelegacion, N'|', ${alias}.estado, N'|', ${alias}.codigoPostal
  )), 2)`;
}

async function ensureGeocodificacionTable(pool) {
  if (!tableReadyPromise) {
    tableReadyPromise = pool.request().query(`
      IF NOT EXISTS (
        SELECT 1 FROM sys.objects
        WHERE object_id = OBJECT_ID(N'lm5k.OrdenesVentaGeocodificacion') AND type = 'U'
      )
      BEGIN
        CREATE TABLE lm5k.OrdenesVentaGeocodificacion (
          idOrden INT NOT NULL PRIMARY KEY,
          latitud DECIMAL(10,7) NOT NULL,
          longitud DECIMAL(10,7) NOT NULL,
          nivelPrecision NVARCHAR(20) NOT NULL,
          huellaDireccion VARCHAR(40) NOT NULL,
          idUsuario INT NULL,
          creationDate DATETIME NOT NULL DEFAULT GETDATE(),
          lastModifiedDate DATETIME NOT NULL DEFAULT GETDATE()
        );
      END
    `).catch((err) => {
      tableReadyPromise = null;
      throw err;
    });
  }
  await tableReadyPromise;
}

function isWithinMexico(lat, lng) {
  return lat >= 14.5 && lat <= 32.7 && lng >= -117.1 && lng <= -86.7;
}

/**
 * Coordenadas guardadas y vigentes (huella de dirección igual a la actual).
 * @returns {Promise<Map<number, {latitud: number, longitud: number, precision: string}>>}
 */
async function obtenerCoordenadasGuardadas(pool, ids) {
  const resultado = new Map();
  const validos = [...new Set((ids || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (!validos.length) return resultado;

  await ensureGeocodificacionTable(pool);

  // Los ids ya son enteros validados; se meten en bloques para no armar un IN gigante.
  for (let i = 0; i < validos.length; i += 1000) {
    const bloque = validos.slice(i, i + 1000).join(',');
    const res = await pool.request().query(`
      SELECT g.idOrden, g.latitud, g.longitud, g.nivelPrecision
      FROM lm5k.OrdenesVentaGeocodificacion g WITH (NOLOCK)
      INNER JOIN lm5k.OrdenesVenta ov WITH (NOLOCK) ON ov.id = g.idOrden
      WHERE g.idOrden IN (${bloque})
        AND g.huellaDireccion = ${huellaDireccionSql('ov')}
    `);
    for (const row of res.recordset || []) {
      resultado.set(Number(row.idOrden), {
        latitud: Number(row.latitud),
        longitud: Number(row.longitud),
        precision: row.nivelPrecision,
      });
    }
  }
  return resultado;
}

function tieneCoordenada(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n !== 0 && String(value ?? '').trim() !== '';
}

/**
 * Igual que obtenerCoordenadasGuardadas pero nunca lanza: si falla, la app
 * simplemente geocodifica como antes. Pensado para correr en paralelo con otras
 * consultas del listado sin sumar tiempo ni riesgo a la respuesta.
 */
async function obtenerCoordenadasSeguras(pool, ids) {
  try {
    return await obtenerCoordenadasGuardadas(pool, ids);
  } catch (err) {
    console.error('[obtenerCoordenadasSeguras] error', err?.message);
    return new Map();
  }
}

/** Agrega latitud/longitud guardadas a las filas que no traigan coordenada propia. */
function aplicarCoordenadas(rows, coords, {
  idKey = 'id',
  latKey = 'latitud',
  lngKey = 'longitud',
} = {}) {
  if (!Array.isArray(rows) || !coords?.size) return rows;
  for (const row of rows) {
    if (!row || tieneCoordenada(row[latKey])) continue;
    const c = coords.get(Number(typeof idKey === 'function' ? idKey(row) : row[idKey]));
    if (!c) continue;
    row[latKey] = c.latitud;
    row[lngKey] = c.longitud;
    row.precisionUbicacion = c.precision;
  }
  return rows;
}

/**
 * Guarda (o actualiza) el punto de una orden. Un punto a nivel 'cp' nunca pisa
 * uno a nivel 'direccion' de la misma dirección.
 * @returns {Promise<boolean>} false si la orden no existe.
 */
async function guardarCoordenada(pool, idOrden, { latitud, longitud, precision, idUsuario }) {
  await ensureGeocodificacionTable(pool);
  const res = await pool.request()
    .input('IdOrden', sql.Int, idOrden)
    .input('Latitud', sql.Decimal(10, 7), latitud)
    .input('Longitud', sql.Decimal(10, 7), longitud)
    .input('Precision', sql.NVarChar(20), precision)
    .input('IdUsuario', sql.Int, idUsuario ?? null)
    .query(`
      DECLARE @Huella VARCHAR(40);
      SELECT @Huella = ${huellaDireccionSql('ov')}
      FROM lm5k.OrdenesVenta ov
      WHERE ov.id = @IdOrden AND ISNULL(ov.deleted, 0) = 0;

      IF @Huella IS NULL
      BEGIN
        SELECT CAST(0 AS BIT) AS ok;
        RETURN;
      END

      MERGE lm5k.OrdenesVentaGeocodificacion AS t
      USING (SELECT @IdOrden AS idOrden) AS s ON t.idOrden = s.idOrden
      WHEN MATCHED AND NOT (
        t.huellaDireccion = @Huella AND t.nivelPrecision = N'direccion' AND @Precision = N'cp'
      ) THEN
        UPDATE SET latitud = @Latitud, longitud = @Longitud, nivelPrecision = @Precision,
                   huellaDireccion = @Huella, idUsuario = @IdUsuario,
                   lastModifiedDate = GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (idOrden, latitud, longitud, nivelPrecision, huellaDireccion, idUsuario)
        VALUES (@IdOrden, @Latitud, @Longitud, @Precision, @Huella, @IdUsuario);

      SELECT CAST(1 AS BIT) AS ok;
    `);
  return Boolean(res.recordset?.[0]?.ok);
}

module.exports = {
  aplicarCoordenadas,
  obtenerCoordenadasSeguras,
  guardarCoordenada,
  isWithinMexico,
};
