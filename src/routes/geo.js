const express = require('express');
const { claveGoogle, isWithinMexico } = require('../services/geocodificacion.service');

// Búsqueda de direcciones para la app (corregir el pin de una orden). La clave de
// Google vive solo en el servidor; la app nunca la usa para Places.
// Places API (New): autocomplete + place details con el mismo sessionToken (Google
// cobra la sesión completa como una sola búsqueda).

const router = express.Router();

async function googleJson(url, { method = 'GET', body, fieldMask } = {}) {
  const key = claveGoogle();
  if (!key) {
    const err = new Error('Búsqueda de direcciones no configurada (falta GOOGLE_MAPS_SERVER_KEY)');
    err.status = 503;
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const resp = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data?.error?.message || `Google respondió ${resp.status}`);
      err.status = 502;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/geo/autocomplete?q=texto&sessionToken=uuid&lat=..&lng=..
 * Sugerencias de direcciones en México, sesgadas a la ubicación dada (el mensajero o la orden).
 */
router.get('/autocomplete', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json({ sugerencias: [] });
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const body = {
      input: q,
      languageCode: 'es',
      regionCode: 'mx',
      includedRegionCodes: ['mx'],
      sessionToken: String(req.query.sessionToken || '') || undefined,
    };
    if (Number.isFinite(lat) && Number.isFinite(lng) && isWithinMexico(lat, lng)) {
      body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 30000 } };
      body.origin = { latitude: lat, longitude: lng };
    }
    const data = await googleJson('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST', body });
    const sugerencias = (data.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        placeId: p.placeId,
        principal: p.structuredFormat?.mainText?.text || p.text?.text || '',
        secundario: p.structuredFormat?.secondaryText?.text || '',
        metros: p.distanceMeters ?? null,
      }));
    res.json({ sugerencias });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/geo/place/:placeId?sessionToken=uuid
 * Coordenada y dirección formateada de una sugerencia elegida.
 */
router.get('/place/:placeId', async (req, res, next) => {
  try {
    const placeId = String(req.params.placeId || '').trim();
    if (!/^[\w-]{10,300}$/.test(placeId)) return res.status(400).json({ error: 'placeId inválido' });
    const qs = new URLSearchParams({ languageCode: 'es', regionCode: 'mx' });
    if (req.query.sessionToken) qs.set('sessionToken', String(req.query.sessionToken));
    const p = await googleJson(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${qs}`,
      { fieldMask: 'id,formattedAddress,location,addressComponents' });
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(404).json({ error: 'Lugar sin ubicación' });
    const cp = (p.addressComponents || []).find((c) => (c.types || []).includes('postal_code'))?.longText || null;
    res.json({ placeId: p.id, direccion: p.formattedAddress, latitud: lat, longitud: lng, codigoPostal: cp });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/geo/reverse?lat=..&lng=..
 * Dirección aproximada de un punto (para mostrar dónde quedó el pin al moverlo).
 */
router.get('/reverse', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isWithinMexico(lat, lng)) {
      return res.status(400).json({ error: 'Coordenadas inválidas' });
    }
    const key = claveGoogle();
    if (!key) return res.status(503).json({ error: 'Geocodificación no configurada' });
    const qs = new URLSearchParams({ latlng: `${lat},${lng}`, language: 'es', key,
      result_type: 'street_address|premise|route|neighborhood|sublocality' });
    const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${qs}`);
    const data = await resp.json().catch(() => ({}));
    const r = (data.results || [])[0];
    const cp = (r?.address_components || []).find((c) => (c.types || []).includes('postal_code'))?.long_name || null;
    res.json({ direccion: r?.formatted_address || null, codigoPostal: cp });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/geo/route
 * Body: { origen: {lat,lng}, destino: {lat,lng} }
 * Ruta en auto con tráfico en tiempo real (Routes API). Devuelve la polilínea
 * codificada, distancia (m) y duración (s) para dibujarla en la app.
 */
router.post('/route', async (req, res, next) => {
  try {
    const o = req.body?.origen || {};
    const d = req.body?.destino || {};
    const ok = (p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && isWithinMexico(Number(p.lat), Number(p.lng));
    if (!ok(o) || !ok(d)) return res.status(400).json({ error: 'Origen o destino inválido' });
    const punto = (p) => ({ location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } });
    const data = await googleJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      fieldMask: 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      body: {
        origin: punto(o),
        destination: punto(d),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        languageCode: 'es-MX',
        regionCode: 'mx',
        units: 'METRIC',
      },
    });
    const r = (data.routes || [])[0];
    if (!r?.polyline?.encodedPolyline) return res.status(404).json({ error: 'No hay ruta vial disponible para ese destino' });
    res.json({
      polilinea: r.polyline.encodedPolyline,
      distanciaMetros: Number(r.distanceMeters) || null,
      duracionSegundos: parseInt(String(r.duration || '').replace('s', ''), 10) || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
