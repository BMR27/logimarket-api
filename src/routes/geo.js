const express = require('express');
const { hereDisponible, calcularRuta, centroCodigoPostal } = require('../services/here.service');
const { isWithinMexico } = require('../services/geocodificacion.service');

const router = express.Router();

function parsePunto(raw) {
  const [lat, lng] = String(raw ?? '').split(',').map((v) => Number(v.trim()));
  return Number.isFinite(lat) && Number.isFinite(lng) && isWithinMexico(lat, lng) ? { lat, lng } : null;
}

/**
 * GET /api/geo/ruta?origen=lat,lng&destino=lat,lng
 * Ruta en auto calculada con HERE (la app ya no llama a Google Directions).
 * Responde { puntos: [[lat, lng], ...], distanciaMetros, duracionSegundos }.
 */
router.get('/ruta', async (req, res, next) => {
  try {
    const origen = parsePunto(req.query.origen);
    const destino = parsePunto(req.query.destino);
    if (!origen || !destino) return res.status(400).json({ error: 'origen y destino deben ser lat,lng dentro de México' });
    if (!hereDisponible()) return res.status(503).json({ error: 'Rutas no configuradas (HERE_API_KEY)' });

    const ruta = await calcularRuta(origen, destino);
    if (!ruta) return res.status(404).json({ error: 'No hay ruta vial disponible para ese destino' });
    res.json(ruta);
  } catch (err) {
    if (err?.status) return res.status(502).json({ error: 'No se pudo calcular la ruta', detail: err.message });
    next(err);
  }
});

/**
 * GET /api/geo/cp/:cp
 * Centro aproximado del código postal. La app lo usa para descartar puntos que
 * caen en otra ciudad y como pin de último recurso.
 */
router.get('/cp/:cp', async (req, res, next) => {
  try {
    const cp = String(req.params.cp || '').replace(/\D/g, '');
    if (cp.length !== 5) return res.status(400).json({ error: 'CP inválido' });
    if (!hereDisponible()) return res.status(503).json({ error: 'Geocodificación no configurada (HERE_API_KEY)' });

    const centro = await centroCodigoPostal(cp);
    if (!centro) return res.status(404).json({ error: 'CP no encontrado' });
    res.json(centro);
  } catch (err) {
    if (err?.status) return res.status(502).json({ error: 'No se pudo ubicar el CP', detail: err.message });
    next(err);
  }
});

module.exports = router;
