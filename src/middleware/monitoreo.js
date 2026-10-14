// Monitoreo de logimarket-api → alertas de NEXT OS LITE (Configuración → Alertas).
// Envía al backend de NEXT OS LITE los errores 5xx, las excepciones y las respuestas lentas de
// esta API, y los errores que reporta la app de mensajeros. Reglas para no afectar nada:
//  · nunca bloquea ni modifica una respuesta: solo mide al terminar;
//  · se envía en lotes cada 10 s, en segundo plano, con tiempo límite; si el backend no
//    responde el lote se descarta (cola con tope);
//  · MONITOREO=off lo apaga.

const DESTINO = (process.env.LM5K_MONITOREO_URL || 'https://nextoslitebackend-production.up.railway.app').replace(/\/+$/, '');
// Llave que identifica a esta API ante NEXT OS LITE: variable de entorno o, si no está, la que
// NEXT OS LITE guarda en la base compartida (lm5k.MonitoreoConfig, se relee cada 10 min).
let llave = process.env.MONITOREO_INGEST_KEY || '';
async function leerLlave() {
  if (process.env.MONITOREO_INGEST_KEY) return;
  try {
    const { getPool, sql } = require('../config/database');
    const pool = await getPool();
    const r = await pool.request().input('clave', sql.NVarChar(50), 'ingest_key')
      .query(`IF OBJECT_ID('lm5k.MonitoreoConfig') IS NOT NULL SELECT valor FROM lm5k.MonitoreoConfig WHERE clave = @clave`);
    llave = r.recordset?.[0]?.valor || '';
  } catch { /* sin llave: los reportes llegan como públicos (sin severidad crítica) */ }
}
setTimeout(() => { leerLlave(); }, 5_000).unref();
setInterval(() => { leerLlave(); }, 10 * 60_000).unref();
const LENTA_MS = Number(process.env.MONITOREO_LENTA_MS) || 5000;
const MAX_COLA = 200;
const activo = () => String(process.env.MONITOREO || '').toLowerCase() !== 'off';

let cola = [];

function encolar(reporte) {
  if (!activo()) return;
  cola.push(reporte);
  if (cola.length > MAX_COLA) cola = cola.slice(-MAX_COLA);
}

/** /api/orders/12345/address → /api/orders/:id/address (agrupa alertas de la misma ruta) */
function rutaGenerica(url) {
  return String(url || '').split('?')[0].split('/')
    .map((s) => (/^\d+$/.test(s) || /^[0-9a-f-]{20,}$/i.test(s) ? ':id' : s)).join('/');
}

function usuarioDe(req) {
  const u = req.user || {};
  const nombre = [u.nombres, u.apellidoPaterno].filter(Boolean).join(' ').trim();
  return nombre || u.correo || (u.id ? `#${u.id}` : undefined);
}

async function enviar() {
  if (!cola.length || !activo()) return;
  const lote = cola.splice(0, 20);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(`${DESTINO}/api/monitoreo/reportar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(llave ? { 'x-monitoreo-key': llave } : {}) },
      body: JSON.stringify({ reportes: lote }),
      signal: ctrl.signal,
    });
  } catch {
    // Sin conexión con NEXT OS LITE: el lote se descarta (no se reintenta para no acumular)
  } finally {
    clearTimeout(t);
  }
}

setInterval(() => { enviar().catch(() => {}); }, 10_000).unref();

/** Mide cada petición y reporta las que terminan en 5xx o tardan más de LENTA_MS. */
function monitoreoMiddleware(req, res, next) {
  const inicio = Date.now();
  let cuerpo;
  const jsonOriginal = res.json.bind(res);
  res.json = (c) => { cuerpo = c; return jsonOriginal(c); };
  res.on('finish', () => {
    try {
      if (!activo() || req.path === '/health' || req.path.startsWith('/api/monitoreo')) return;
      const ms = Date.now() - inicio;
      const status = res.statusCode;
      if (status < 500 && ms < LENTA_MS) return;
      if (res.locals.monitoreoErrorReportado) return;
      const mensaje = (cuerpo && (cuerpo.detail || cuerpo.error || cuerpo.message)) || `HTTP ${status}`;
      encolar({
        origen: 'app-api', tipo: status >= 500 ? 'error' : 'lento',
        mensaje: status >= 500 ? String(mensaje) : `Respuesta lenta: ${(ms / 1000).toFixed(1)} s`,
        metodo: req.method, ruta: rutaGenerica(req.originalUrl), status, duracionMs: ms,
        usuario: usuarioDe(req), dispositivo: req.headers['user-agent'],
      });
    } catch { /* el monitoreo nunca debe afectar la respuesta */ }
  });
  next();
}

/** Lo llama errorHandler con la excepción completa (incluye stack). */
function reportarExcepcion(err, req, res) {
  try {
    if (res) res.locals.monitoreoErrorReportado = true;
    encolar({
      origen: 'app-api', tipo: 'error', mensaje: err?.message || String(err), stack: err?.stack || null,
      metodo: req?.method, ruta: req ? rutaGenerica(req.originalUrl) : 'proceso', status: 500,
      usuario: req ? usuarioDe(req) : undefined, dispositivo: req?.headers?.['user-agent'],
    });
  } catch { /* noop */ }
}

/** Error del cliente que conviene ver pero no es falla del servidor: se registra como
 *  advertencia aunque se repita (NEXT OS LITE no la sube a crítica). */
function reportarAviso(mensaje, req, res, status) {
  try {
    if (res) res.locals.monitoreoErrorReportado = true;
    encolar({
      origen: 'app-api', tipo: 'error', severidad: 'advertencia', mensaje,
      metodo: req?.method, ruta: req ? rutaGenerica(req.originalUrl) : 'proceso', status,
      usuario: req ? usuarioDe(req) : undefined, dispositivo: req?.headers?.['user-agent'],
    });
  } catch { /* noop */ }
}

// POST /api/monitoreo/app — errores y lentitud que reporta la app de mensajeros (Flutter).
// Sin autenticación obligatoria (la app puede tener la sesión vencida); validado y con tope.
const recibidosPorIp = new Map();
function recibirReporteApp(req, res) {
  try {
    const ip = req.ip || 'desconocida';
    const ahora = Date.now();
    const l = (recibidosPorIp.get(ip) || []).filter((t) => ahora - t < 60_000);
    l.push(ahora);
    recibidosPorIp.set(ip, l);
    if (recibidosPorIp.size > 5000) recibidosPorIp.clear();
    if (l.length > 30) return res.status(429).json({ ok: false });
    const lista = Array.isArray(req.body?.reportes) ? req.body.reportes.slice(0, 10) : [req.body];
    for (const r of lista) {
      if (!r || !r.mensaje) continue;
      encolar({
        origen: 'app', tipo: r.tipo === 'lento' ? 'lento' : 'error',
        mensaje: String(r.mensaje).slice(0, 1000), stack: r.stack ? String(r.stack).slice(0, 6000) : null,
        pantalla: r.pantalla ? String(r.pantalla).slice(0, 200) : undefined,
        ruta: r.ruta ? String(r.ruta).slice(0, 300) : undefined, metodo: r.metodo, status: Number(r.status) || undefined,
        duracionMs: Number(r.duracionMs) || undefined, version: r.version ? String(r.version).slice(0, 50) : undefined,
        plataforma: r.plataforma ? String(r.plataforma).slice(0, 80) : undefined,
        dispositivo: r.dispositivo ? String(r.dispositivo).slice(0, 200) : req.headers['user-agent'],
        usuario: r.usuario ? String(r.usuario).slice(0, 150) : undefined, idUsuario: Number(r.idUsuario) || undefined,
      });
    }
  } catch { /* noop */ }
  res.json({ ok: true });
}

module.exports = { monitoreoMiddleware, reportarExcepcion, reportarAviso, recibirReporteApp };
