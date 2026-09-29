const { sql } = require('../config/database');

// lm5k.OrdenesVenta no tiene latitud/longitud: la app geocodificaba cada orden en
// cada celular y en cada sesión (lento y con costo en Google). Aquí se guarda el
// punto ya validado contra el CP para que se calcule una sola vez.
//
// huellaDireccion es un hash de los campos de dirección al momento de guardar;
// si alguien edita la dirección de la orden, la huella ya no coincide, el punto
// se ignora y la app vuelve a geocodificar y a guardar.
//
// precision (de menor a mayor confianza):
//   'cp'        = sin coincidencia confiable, se usó el centro del CP.
//   'colonia'   = Google ubicó la colonia/fraccionamiento dentro del CP.
//   'direccion' = se encontró la calle dentro del CP (lo que guardaban las versiones
//                 anteriores de la app al geocodificar en el celular).
//   'exacta'    = Google ubicó la calle y el número (ROOFTOP / interpolado).
//   'entrega'   = GPS del mensajero al calificar la orden como Exitosa.
//   'manual'    = el mensajero movió el pin a mano: es la verdad de campo.
// Un punto nunca se sustituye por otro de menor confianza para la misma dirección.

const RANGO_PRECISION = { cp: 1, colonia: 2, direccion: 3, exacta: 4, entrega: 5, manual: 6 };
const PRECISIONES = Object.keys(RANGO_PRECISION);

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
      END;
      -- Rango de la precisión (para comparar en SQL) y de dónde salió el punto
      IF COL_LENGTH('lm5k.OrdenesVentaGeocodificacion', 'fuente') IS NULL
        ALTER TABLE lm5k.OrdenesVentaGeocodificacion ADD fuente NVARCHAR(20) NULL;
      IF COL_LENGTH('lm5k.OrdenesVentaGeocodificacion', 'direccionFormateada') IS NULL
        ALTER TABLE lm5k.OrdenesVentaGeocodificacion ADD direccionFormateada NVARCHAR(400) NULL;
      IF COL_LENGTH('lm5k.OrdenesVentaGeocodificacion', 'placeId') IS NULL
        ALTER TABLE lm5k.OrdenesVentaGeocodificacion ADD placeId NVARCHAR(300) NULL;
      -- Centro de cada CP (Google), para no consultarlo en cada orden
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'lm5k.CodigosPostalesGeo') AND type = 'U')
        CREATE TABLE lm5k.CodigosPostalesGeo (
          cp CHAR(5) NOT NULL PRIMARY KEY,
          latitud DECIMAL(10,7) NOT NULL,
          longitud DECIMAL(10,7) NOT NULL,
          creationDate DATETIME NOT NULL DEFAULT GETDATE()
        );
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

function rangoSql(col) {
  return `CASE ${col} ${PRECISIONES.map((p) => `WHEN N'${p}' THEN ${RANGO_PRECISION[p]}`).join(' ')} ELSE 0 END`;
}

/**
 * Guarda (o actualiza) el punto de una orden. Para la misma dirección un punto nunca
 * se sustituye por otro de menor confianza (ver RANGO_PRECISION); 'manual' siempre gana.
 * @returns {Promise<boolean>} false si la orden no existe.
 */
async function guardarCoordenada(pool, idOrden, {
  latitud, longitud, precision, idUsuario, fuente = 'app', direccionFormateada = null, placeId = null,
}) {
  await ensureGeocodificacionTable(pool);
  const nivel = RANGO_PRECISION[precision] ? precision : 'direccion';
  const res = await pool.request()
    .input('IdOrden', sql.Int, idOrden)
    .input('Latitud', sql.Decimal(10, 7), latitud)
    .input('Longitud', sql.Decimal(10, 7), longitud)
    .input('Precision', sql.NVarChar(20), nivel)
    .input('Rango', sql.Int, RANGO_PRECISION[nivel])
    .input('IdUsuario', sql.Int, idUsuario ?? null)
    .input('Fuente', sql.NVarChar(20), fuente)
    .input('DireccionFormateada', sql.NVarChar(400), direccionFormateada ? String(direccionFormateada).slice(0, 400) : null)
    .input('PlaceId', sql.NVarChar(300), placeId ? String(placeId).slice(0, 300) : null)
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
      WHEN MATCHED AND (
        t.huellaDireccion <> @Huella OR @Precision = N'manual' OR @Rango >= ${rangoSql('t.nivelPrecision')}
      ) THEN
        UPDATE SET latitud = @Latitud, longitud = @Longitud, nivelPrecision = @Precision,
                   huellaDireccion = @Huella, idUsuario = @IdUsuario, fuente = @Fuente,
                   direccionFormateada = COALESCE(@DireccionFormateada, CASE WHEN t.huellaDireccion = @Huella THEN t.direccionFormateada END),
                   placeId = COALESCE(@PlaceId, CASE WHEN t.huellaDireccion = @Huella THEN t.placeId END),
                   lastModifiedDate = GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (idOrden, latitud, longitud, nivelPrecision, huellaDireccion, idUsuario, fuente, direccionFormateada, placeId)
        VALUES (@IdOrden, @Latitud, @Longitud, @Precision, @Huella, @IdUsuario, @Fuente, @DireccionFormateada, @PlaceId);

      SELECT CAST(1 AS BIT) AS ok;
    `);
  return Boolean(res.recordset?.[0]?.ok);
}

// ── Geocodificación en el servidor (Google) ──────────────────────────────────
// La app ya no geocodifica en el celular: pide al servidor los puntos de su mochila.
// El servidor geocodifica una sola vez por dirección con Google y valida el resultado
// contra el centro del CP (descarta lo que caiga a más de MAX_KM_DESDE_CP).

const MAX_KM_DESDE_CP = 10;

function claveGoogle() {
  return (process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY || '').trim();
}

function distanciaKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// El geocodificador lee "Mexico" como el país, no como el Estado de México.
function normalizarEstado(estado) {
  const e = String(estado || '').trim();
  const key = e.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  const edomex = new Set(['mexico', 'estado de mexico', 'edo de mexico', 'edo mex', 'edomex', 'edo mexico', 'mex', 'edo de mex']);
  return edomex.has(key) ? 'Estado de México' : e;
}

// Los clientes capturan referencias dentro de la calle ("... entre camelias y dalias");
// con ese ruido Google se queda con la frase más conocida. Se corta en la referencia.
function limpiarCalle(raw) {
  return String(raw || '')
    .replace(/^\s*calle\s*\.\s*/i, 'Calle ')
    .replace(/\s+(entre|esquina|esq|frente|junto|cerca de|atras|atrás|a un lado|a lado|la casa|casa de)(\s|\.|,|$).*$/i, '')
    .trim();
}

async function googleGeocode(params) {
  const key = claveGoogle();
  if (!key) return null;
  const qs = new URLSearchParams({ ...params, language: 'es', region: 'mx', key });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${qs}`, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'OK') {
      if (data.status !== 'ZERO_RESULTS') console.warn('[geocode] Google', data.status, data.error_message || '');
      return [];
    }
    return data.results || [];
  } catch (err) {
    console.warn('[geocode] Google error', err?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const cpEnVuelo = new Map();
/** Centro del CP (caché en BD y en memoria). */
async function centroCp(pool, rawCp) {
  const cp = String(rawCp || '').replace(/\D/g, '');
  if (cp.length !== 5) return null;
  if (cpEnVuelo.has(cp)) return cpEnVuelo.get(cp);
  const p = (async () => {
    await ensureGeocodificacionTable(pool);
    const r = await pool.request().input('cp', sql.Char(5), cp)
      .query('SELECT latitud, longitud FROM lm5k.CodigosPostalesGeo WITH (NOLOCK) WHERE cp = @cp');
    if (r.recordset.length) return { lat: Number(r.recordset[0].latitud), lng: Number(r.recordset[0].longitud) };
    const results = await googleGeocode({ components: `postal_code:${cp}|country:MX` });
    const hit = (results || []).find((x) => (x.address_components || [])
      .some((c) => (c.types || []).includes('postal_code') && c.long_name === cp));
    const loc = hit?.geometry?.location;
    if (!loc || !isWithinMexico(loc.lat, loc.lng)) return null;
    await pool.request().input('cp', sql.Char(5), cp).input('lat', sql.Decimal(10, 7), loc.lat).input('lng', sql.Decimal(10, 7), loc.lng)
      .query(`IF NOT EXISTS (SELECT 1 FROM lm5k.CodigosPostalesGeo WHERE cp = @cp)
              INSERT INTO lm5k.CodigosPostalesGeo (cp, latitud, longitud) VALUES (@cp, @lat, @lng)`)
      .catch(() => {});
    return { lat: loc.lat, lng: loc.lng };
  })();
  cpEnVuelo.set(cp, p);
  try {
    const v = await p;
    if (!v) cpEnVuelo.delete(cp); // reintentar en otra consulta (red/cuota)
    return v;
  } catch (err) {
    cpEnVuelo.delete(cp);
    throw err;
  }
}

/** Nivel de precisión de un resultado de Google. */
function nivelResultado(r) {
  const types = new Set(r.types || []);
  const comp = new Set((r.address_components || []).flatMap((c) => c.types || []));
  const lt = r.geometry?.location_type;
  if ((types.has('street_address') || types.has('premise') || types.has('subpremise') || comp.has('street_number'))
    && (lt === 'ROOFTOP' || lt === 'RANGE_INTERPOLATED')) return 'exacta';
  if (types.has('route') || types.has('intersection') || comp.has('route')) return 'direccion';
  if (types.has('neighborhood') || types.has('sublocality') || types.has('sublocality_level_1')
    || types.has('political') && comp.has('sublocality')) return 'colonia';
  return 'cp';
}

/**
 * Geocodifica una dirección de orden en el servidor.
 * @returns {Promise<{lat:number,lng:number,precision:string,direccionFormateada?:string,placeId?:string}|null>}
 */
async function geocodificarDireccion(pool, dir) {
  const cp = String(dir.codigoPostal || '').replace(/\D/g, '');
  const ancla = await centroCp(pool, cp);
  const calle = `${limpiarCalle(dir.calle)} ${String(dir.numExterior || '').trim()}`.trim();
  const colonia = String(dir.colonia || '').trim();
  const municipio = String(dir.municipioDelegacion || '').trim();
  const estado = normalizarEstado(dir.estado);
  const componentes = cp.length === 5 ? `postal_code:${cp}|country:MX` : 'country:MX';

  // Del intento más específico al más general; se queda con el mejor resultado válido
  const intentos = [
    calle && [calle, colonia, municipio, estado].filter(Boolean).join(', '),
    calle && [calle, colonia].filter(Boolean).join(', '),
    colonia && [colonia, municipio, estado].filter(Boolean).join(', '),
  ].filter(Boolean);

  let mejor = null;
  for (const address of [...new Set(intentos)]) {
    const results = await googleGeocode({ address, components: componentes });
    if (results === null) break; // sin clave o sin red: no seguir gastando intentos
    for (const r of results) {
      const loc = r.geometry?.location;
      if (!loc || !isWithinMexico(loc.lat, loc.lng)) continue;
      if (ancla && distanciaKm(ancla, loc) > MAX_KM_DESDE_CP) continue;
      const precision = nivelResultado(r);
      if (!mejor || RANGO_PRECISION[precision] > RANGO_PRECISION[mejor.precision]) {
        mejor = { lat: loc.lat, lng: loc.lng, precision, direccionFormateada: r.formatted_address, placeId: r.place_id };
      }
    }
    if (mejor && RANGO_PRECISION[mejor.precision] >= RANGO_PRECISION.direccion) break;
  }
  if (mejor) return mejor;
  return ancla ? { lat: ancla.lat, lng: ancla.lng, precision: 'cp' } : null;
}

async function direccionesDeOrdenes(pool, ids) {
  if (!ids.length) return [];
  const r = await pool.request().query(`
    SELECT ov.id, ov.calle, ov.numExterior, ov.colonia, ov.municipioDelegacion, ov.estado, ov.codigoPostal
    FROM lm5k.OrdenesVenta ov WITH (NOLOCK)
    WHERE ov.id IN (${ids.join(',')}) AND ISNULL(ov.deleted, 0) = 0`);
  return r.recordset || [];
}

async function enParalelo(items, limite, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

/**
 * Puntos de un conjunto de órdenes: devuelve los guardados y geocodifica en el servidor
 * los que falten (hasta `maxNuevos` por llamada, para acotar tiempo y costo).
 * @returns {Promise<{coords: Record<number,{latitud:number,longitud:number,precision:string}>, pendientes:number[]}>}
 */
async function resolverCoordenadas(pool, ids, { maxNuevos = 40 } = {}) {
  const validos = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 500);
  const guardadas = await obtenerCoordenadasGuardadas(pool, validos);
  const coords = {};
  for (const [id, c] of guardadas) coords[id] = c;
  const faltan = validos.filter((id) => !guardadas.has(id));
  const ahora = faltan.slice(0, maxNuevos);
  const pendientes = faltan.slice(maxNuevos);
  if (ahora.length && claveGoogle()) {
    const dirs = await direccionesDeOrdenes(pool, ahora);
    await enParalelo(dirs, 5, async (d) => {
      try {
        const g = await geocodificarDireccion(pool, d);
        if (!g) return;
        coords[d.id] = { latitud: g.lat, longitud: g.lng, precision: g.precision };
        await guardarCoordenada(pool, d.id, {
          latitud: g.lat, longitud: g.lng, precision: g.precision, fuente: 'servidor',
          direccionFormateada: g.direccionFormateada, placeId: g.placeId,
        });
      } catch (err) {
        console.warn('[resolverCoordenadas] orden', d.id, err?.message);
      }
    });
  } else if (ahora.length) {
    pendientes.unshift(...ahora);
  }
  return { coords, pendientes };
}

/** Punto guardado de una sola orden (o null). */
async function coordenadaDeOrden(pool, idOrden) {
  const m = await obtenerCoordenadasGuardadas(pool, [idOrden]);
  return m.get(Number(idOrden)) || null;
}

module.exports = {
  aplicarCoordenadas,
  obtenerCoordenadasSeguras,
  guardarCoordenada,
  isWithinMexico,
  resolverCoordenadas,
  coordenadaDeOrden,
  centroCp,
  distanciaKm,
  claveGoogle,
  RANGO_PRECISION,
};
