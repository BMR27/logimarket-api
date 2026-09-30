const { sql } = require('../config/database');
const { hereDisponible, geocodificarDireccion } = require('./here.service');

// lm5k.OrdenesVenta no tiene latitud/longitud: la app geocodificaba cada orden en
// cada celular y en cada sesión (lento y con costo en Google). Aquí se guarda el
// punto para que se calcule una sola vez.
//
// huellaDireccion es un hash de los campos de dirección al momento de guardar;
// si alguien edita la dirección de la orden, la huella ya no coincide, el punto
// se ignora y se vuelve a geocodificar.
//
// Con HERE_API_KEY, el servidor geocodifica con HERE (ver here.service.js):
//   exacta | interpolada | calle | zona
// Sin HERE, o si HERE no encuentra la dirección, la app geocodifica y manda:
//   direccion = la app encontró la calle/colonia dentro del CP;
//   cp        = sin coincidencia confiable, se usó el centro del CP.

// Niveles calculados por HERE en el servidor: un punto de la app no los pisa.
const PRECISIONES_HERE = ['exacta', 'interpolada', 'calle', 'zona'];

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

// Órdenes que HERE no pudo resolver: no se reintentan en cada request (la app las
// resuelve con sus respaldos). Se olvidan pasado un rato por si fue un error de red.
const FALLOS_HERE_TTL_MS = 6 * 60 * 60 * 1000;
const fallosHere = new Map();
// Mismas órdenes pedidas por varios requests a la vez: una sola consulta a HERE.
const enCurso = new Map();

function falloReciente(idOrden) {
  const t = fallosHere.get(idOrden);
  if (t && Date.now() - t < FALLOS_HERE_TTL_MS) return true;
  if (t) fallosHere.delete(idOrden);
  return false;
}

async function direccionesDeOrdenes(pool, ids) {
  const res = await pool.request().query(`
    SELECT id, calle, numExterior, colonia, codigoPostal, municipioDelegacion, estado
    FROM lm5k.OrdenesVenta WITH (NOLOCK)
    WHERE id IN (${ids.join(',')}) AND ISNULL(deleted, 0) = 0
  `);
  return res.recordset || [];
}

/** Geocodifica una orden con HERE y guarda el punto. null si no se pudo. */
function geocodificarYGuardar(pool, orden) {
  const id = Number(orden.id);
  if (enCurso.has(id)) return enCurso.get(id);
  const p = (async () => {
    try {
      const punto = await geocodificarDireccion(orden);
      if (!punto || !isWithinMexico(punto.latitud, punto.longitud)) {
        fallosHere.set(id, Date.now());
        return null;
      }
      await guardarCoordenada(pool, id, { ...punto, idUsuario: null });
      return punto;
    } catch (err) {
      fallosHere.set(id, Date.now());
      console.error(`[geocodificacion] HERE falló para la orden ${id}:`, err?.message);
      return null;
    } finally {
      enCurso.delete(id);
    }
  })();
  enCurso.set(id, p);
  return p;
}

// Corre `fn` sobre `items` con a lo más `limite` en paralelo.
async function enParalelo(items, limite, fn) {
  let i = 0;
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(trabajadores);
}

// Tiempo máximo que un listado espera a HERE; lo que no termine se sigue
// resolviendo en segundo plano y aparece en la siguiente carga.
const ESPERA_MAX_LISTADO_MS = 2500;

/**
 * Igual que obtenerCoordenadasGuardadas pero nunca lanza: si falla, la app
 * simplemente geocodifica como antes. Con HERE configurado, las órdenes sin
 * punto se geocodifican en el servidor (esperando a lo más ESPERA_MAX_LISTADO_MS).
 */
async function obtenerCoordenadasSeguras(pool, ids) {
  let coords;
  try {
    coords = await obtenerCoordenadasGuardadas(pool, ids);
  } catch (err) {
    console.error('[obtenerCoordenadasSeguras] error', err?.message);
    return new Map();
  }
  if (!hereDisponible()) return coords;

  try {
    const faltantes = [...new Set((ids || []).map(Number))]
      .filter((id) => Number.isInteger(id) && id > 0 && !coords.has(id) && !falloReciente(id));
    if (!faltantes.length) return coords;

    const ordenes = await direccionesDeOrdenes(pool, faltantes);
    const trabajo = enParalelo(ordenes, 6, async (o) => {
      const punto = await geocodificarYGuardar(pool, o);
      if (punto) coords.set(Number(o.id), punto);
    });
    await Promise.race([trabajo, new Promise((r) => setTimeout(r, ESPERA_MAX_LISTADO_MS))]);
    // Copia: lo que termine después ya no debe mutar el Map que usa la respuesta.
    return new Map(coords);
  } catch (err) {
    console.error('[obtenerCoordenadasSeguras] HERE error', err?.message);
    return coords;
  }
}

/**
 * Geocodifica en segundo plano las órdenes activas (por asignar, asignadas,
 * en intento o en ruta) que aún no tienen punto, para que el mensajero ya las
 * vea en el mapa al abrir la app. Solo corre con HERE_API_KEY.
 */
function iniciarGeocodificacionPendientes(getPool, { cadaMs = 60000, lote = 40 } = {}) {
  if (!hereDisponible() || process.env.GEOCODIFICAR_PENDIENTES === '0') return null;
  let corriendo = false;
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const pool = await getPool();
      await ensureGeocodificacionTable(pool);
      // Ventana por id (índice clustered) para no recorrer toda la tabla de órdenes.
      const res = await pool.request().input('Lote', sql.Int, lote).query(`
        DECLARE @Desde INT = (SELECT MAX(id) FROM lm5k.OrdenesVenta) - 200000;
        SELECT TOP (@Lote) ov.id, ov.calle, ov.numExterior, ov.colonia, ov.codigoPostal,
               ov.municipioDelegacion, ov.estado
        FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
        LEFT JOIN lm5k.OrdenesVentaGeocodificacion g WITH (NOLOCK) ON g.idOrden = ov.id
        WHERE ov.id > @Desde
          AND ISNULL(ov.deleted, 0) = 0
          AND ov.idStatus IN (2, 3, 5, 6, 7)
          AND LEN(LTRIM(ISNULL(ov.codigoPostal, ''))) = 5
          AND (g.idOrden IS NULL OR g.huellaDireccion <> ${huellaDireccionSql('ov')})
        ORDER BY ov.id DESC
      `);
      const pendientes = (res.recordset || []).filter((o) => !falloReciente(Number(o.id)));
      await enParalelo(pendientes, 4, (o) => geocodificarYGuardar(pool, o));
    } catch (err) {
      console.error('[geocodificacion] pendientes:', err?.message);
    } finally {
      corriendo = false;
    }
  };
  const timer = setInterval(tick, cadaMs);
  timer.unref?.();
  setTimeout(tick, 15000).unref?.();
  console.log('[geocodificacion] HERE activo: geocodificando órdenes pendientes en segundo plano');
  return timer;
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
 * Guarda (o actualiza) el punto de una orden. Para la misma dirección, un punto
 * de la app nunca pisa uno de HERE, y uno a nivel 'cp' nunca pisa uno a nivel
 * 'direccion'.
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
        t.huellaDireccion = @Huella AND (
          (t.nivelPrecision = N'direccion' AND @Precision = N'cp')
          OR (t.nivelPrecision IN (${PRECISIONES_HERE.map((p) => `N'${p}'`).join(', ')})
              AND @Precision NOT IN (${PRECISIONES_HERE.map((p) => `N'${p}'`).join(', ')}))
        )
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
  iniciarGeocodificacionPendientes,
  isWithinMexico,
};
