// Cliente de HERE (geocodificación y rutas). La key vive solo en el servidor
// (HERE_API_KEY) para no exponerla en la app ni pagar consultas repetidas desde
// cada celular.
//
// En una prueba con 200 entregas reales, HERE ubicó el 68% de las direcciones a
// nivel de número exterior (mediana ~28 m del GPS de entrega); la búsqueda por
// campos (qq) salió mejor que la de texto libre, que queda como respaldo.

const GEOCODE_URL = 'https://geocode.search.hereapi.com/v1/geocode';
const ROUTES_URL = 'https://router.hereapi.com/v8/routes';
const TIMEOUT_MS = 6000;

function apiKey() {
  return String(process.env.HERE_API_KEY || '').trim();
}

function hereDisponible() {
  return apiKey() !== '';
}

function limpiar(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

// Algunos clientes capturan entre calles y referencias dentro del campo de calle
// ("Calle.azalias ... entre camelias y dalias la casa es de piedra"); se corta en
// la primera palabra típica de referencia (mismo criterio que usaba la app).
const RUIDO_CALLE = /\s+(entre|esquina|esq|frente|junto|cerca de|atras|atrás|a un lado|a lado|la casa|casa de)(\s|\.|,|$).*$/i;

function limpiarCalle(raw) {
  return limpiar(raw)
    .replace(/^\s*calle\s*\.\s*/i, 'Calle ')
    .replace(RUIDO_CALLE, '')
    .trim();
}

// "Mexico" solo se lee como el país; el Estado de México hay que nombrarlo completo.
function normalizarEstado(estado) {
  const e = limpiar(estado);
  const k = e.toLowerCase().replace(/é/g, 'e').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  const edomex = new Set(['mexico', 'estado de mexico', 'edo de mexico', 'edo mex', 'edomex', 'edo mexico', 'mex', 'edo de mex']);
  return edomex.has(k) ? 'Estado de México' : e;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`HERE ${res.status}: ${body?.title || body?.error_description || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * Nivel de precisión que se guarda en OrdenesVentaGeocodificacion.nivelPrecision:
 *   exacta     = número exterior encontrado en el mapa (point address)
 *   interpolada = número estimado entre dos conocidos de la misma calle
 *   calle      = solo se encontró la calle
 *   zona       = colonia, CP o localidad (el pin es aproximado)
 */
function nivelPrecision(item) {
  if (item.resultType === 'houseNumber') {
    return item.houseNumberType === 'interpolated' ? 'interpolada' : 'exacta';
  }
  if (item.resultType === 'street' || item.resultType === 'intersection') return 'calle';
  return 'zona';
}

function aResultado(item) {
  if (!item?.position) return null;
  return {
    latitud: Number(item.position.lat),
    longitud: Number(item.position.lng),
    precision: nivelPrecision(item),
  };
}

/**
 * Geocodifica una dirección de orden. Primero por campos (qq); si no hay
 * resultado, con el texto completo acotado a México.
 * @returns {Promise<{latitud:number, longitud:number, precision:string}|null>}
 */
async function geocodificarDireccion(dir) {
  const key = apiKey();
  if (!key) return null;

  const calle = limpiarCalle(dir.calle);
  const estado = normalizarEstado(dir.estado);
  const campos = [
    ['street', calle],
    ['houseNumber', limpiar(dir.numExterior)],
    ['district', limpiar(dir.colonia)],
    ['postalCode', limpiar(dir.codigoPostal)],
    ['city', limpiar(dir.municipioDelegacion)],
    ['state', estado],
  ].filter(([, v]) => v).map(([k, v]) => `${k}=${v.replace(/;/g, ' ')}`);
  if (!campos.length) return null;

  const qq = [...campos, 'country=MEX'].join(';');
  const porCampos = await getJson(`${GEOCODE_URL}?qq=${encodeURIComponent(qq)}&lang=es&limit=1&apiKey=${encodeURIComponent(key)}`);
  const r1 = aResultado(porCampos.items?.[0]);
  if (r1) return r1;

  const texto = [
    limpiar(`${calle} ${limpiar(dir.numExterior)}`),
    limpiar(dir.colonia), limpiar(dir.codigoPostal), limpiar(dir.municipioDelegacion), estado, 'México',
  ].filter(Boolean).join(', ');
  const libre = await getJson(`${GEOCODE_URL}?q=${encodeURIComponent(texto)}&in=countryCode:MEX&lang=es&limit=1&apiKey=${encodeURIComponent(key)}`);
  return aResultado(libre.items?.[0]);
}

// Centro de cada CP: cambia muy poco, así que se guarda en memoria del proceso.
const cacheCp = new Map();

/** Centro aproximado de un código postal mexicano. */
async function centroCodigoPostal(cp) {
  const key = apiKey();
  const limpio = String(cp ?? '').replace(/\D/g, '');
  if (!key || limpio.length !== 5) return null;
  if (cacheCp.has(limpio)) return cacheCp.get(limpio);

  const d = await getJson(`${GEOCODE_URL}?qq=${encodeURIComponent(`postalCode=${limpio};country=MEX`)}&lang=es&limit=1&apiKey=${encodeURIComponent(key)}`);
  const item = d.items?.[0];
  const res = item?.position && item.address?.postalCode === limpio
    ? { latitud: Number(item.position.lat), longitud: Number(item.position.lng) }
    : null;
  if (cacheCp.size > 20000) cacheCp.clear();
  cacheCp.set(limpio, res);
  return res;
}

// Decodificador de "flexible polyline" (formato de HERE Routing v8).
// Especificación: https://github.com/heremaps/flexible-polyline
const TABLA_POLYLINE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALOR_CARACTER = new Map([...TABLA_POLYLINE].map((c, i) => [c, i]));

function decodificarPolyline(encoded) {
  const valores = [];
  let actual = 0;
  let shift = 0;
  for (const c of String(encoded || '')) {
    const v = VALOR_CARACTER.get(c);
    if (v === undefined) throw new Error('Polyline inválida');
    actual += (v & 0x1f) * 2 ** shift;
    if (v & 0x20) {
      shift += 5;
    } else {
      valores.push(actual);
      actual = 0;
      shift = 0;
    }
  }
  if (valores.length < 2 || valores[0] !== 1) throw new Error('Versión de polyline no soportada');

  const header = valores[1];
  const factor = 10 ** (header & 15);
  const tercera = (header >> 4) & 7;
  const aSigned = (u) => (u % 2 ? -(u + 1) / 2 : u / 2);

  const puntos = [];
  let lat = 0;
  let lng = 0;
  const paso = tercera ? 3 : 2;
  for (let i = 2; i + 1 < valores.length; i += paso) {
    lat += aSigned(valores[i]);
    lng += aSigned(valores[i + 1]);
    puntos.push([lat / factor, lng / factor]);
  }
  return puntos;
}

/**
 * Ruta en auto entre dos puntos.
 * @returns {Promise<{puntos: Array<[number, number]>, distanciaMetros: number, duracionSegundos: number}|null>}
 */
async function calcularRuta(origen, destino) {
  const key = apiKey();
  if (!key) return null;
  const url = `${ROUTES_URL}?transportMode=car&origin=${origen.lat},${origen.lng}`
    + `&destination=${destino.lat},${destino.lng}&return=polyline,summary&lang=es-MX&apiKey=${encodeURIComponent(key)}`;
  const d = await getJson(url);
  const secciones = d.routes?.[0]?.sections || [];
  if (!secciones.length) return null;

  const puntos = [];
  let distanciaMetros = 0;
  let duracionSegundos = 0;
  for (const s of secciones) {
    puntos.push(...decodificarPolyline(s.polyline));
    distanciaMetros += Number(s.summary?.length) || 0;
    duracionSegundos += Number(s.summary?.duration) || 0;
  }
  return puntos.length ? { puntos, distanciaMetros, duracionSegundos } : null;
}

module.exports = {
  hereDisponible,
  geocodificarDireccion,
  centroCodigoPostal,
  calcularRuta,
  decodificarPolyline,
};
