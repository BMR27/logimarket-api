// Arma el recorrido de un día a partir de los pings GPS del mensajero
// (lm5k.tb_mensajero_ubicacion_history): descarta puntos imprecisos o
// imposibles, parte el trayecto donde se perdió la señal, lo simplifica para
// que la web lo dibuje rápido y detecta paradas.

const PRECISION_MAX_M = 100;         // GPS con peor precisión no se dibuja
const VELOCIDAD_MAX_KMH = 140;       // un salto más rápido que esto es un error de GPS
const SIN_SENAL_MIN = 10;            // hueco mayor a esto parte el trayecto
const PARADA_RADIO_M = 60;           // se considera la misma parada dentro de este radio
const PARADA_MIN = 4;                // tiempo mínimo en un lugar para contar como parada
const SIMPLIFICAR_TOLERANCIA_M = 8;  // Douglas–Peucker: desviación máxima al simplificar

function distanciaM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Descarta puntos imprecisos y saltos imposibles (GPS rebotando). */
function limpiarPuntos(puntos) {
  const limpios = [];
  for (const p of puntos) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (p.accuracy != null && p.accuracy > PRECISION_MAX_M) continue;
    const prev = limpios[limpios.length - 1];
    if (prev) {
      const seg = (p.t - prev.t) / 1000;
      if (seg <= 0) continue;
      const kmh = (distanciaM(prev, p) / seg) * 3.6;
      if (kmh > VELOCIDAD_MAX_KMH) continue;
    }
    limpios.push(p);
  }
  return limpios;
}

// Douglas–Peucker sobre una proyección local en metros (suficiente a escala ciudad).
function simplificar(puntos, toleranciaM = SIMPLIFICAR_TOLERANCIA_M) {
  if (puntos.length <= 2) return puntos.slice();
  const lat0 = (puntos[0].lat * Math.PI) / 180;
  const xy = puntos.map((p) => ({
    x: p.lng * 111320 * Math.cos(lat0),
    y: p.lat * 110540,
  }));
  const conservar = new Uint8Array(puntos.length);
  conservar[0] = 1;
  conservar[puntos.length - 1] = 1;
  const pila = [[0, puntos.length - 1]];
  while (pila.length) {
    const [i, j] = pila.pop();
    const a = xy[i];
    const b = xy[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const largo2 = dx * dx + dy * dy;
    let maxD = 0;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const p = xy[k];
      let d;
      if (largo2 === 0) {
        d = Math.hypot(p.x - a.x, p.y - a.y);
      } else {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / largo2));
        d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      }
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (idx !== -1 && maxD > toleranciaM) {
      conservar[idx] = 1;
      pila.push([i, idx], [idx, j]);
    }
  }
  return puntos.filter((_, k) => conservar[k]);
}

/**
 * Paradas: tiempo continuo dentro de PARADA_RADIO_M de un mismo lugar por al
 * menos PARADA_MIN minutos. También cuenta un hueco de señal largo sin
 * desplazamiento (el celular dejó de mandar mientras estaba quieto).
 */
function detectarParadas(puntos) {
  const paradas = [];
  let i = 0;
  while (i < puntos.length) {
    const ancla = puntos[i];
    let j = i + 1;
    while (j < puntos.length && distanciaM(ancla, puntos[j]) <= PARADA_RADIO_M) j++;
    const fin = puntos[j - 1];
    const minutos = (fin.t - ancla.t) / 60000;
    if (j - 1 > i && minutos >= PARADA_MIN) {
      const grupo = puntos.slice(i, j);
      paradas.push({
        lat: grupo.reduce((s, p) => s + p.lat, 0) / grupo.length,
        lng: grupo.reduce((s, p) => s + p.lng, 0) / grupo.length,
        inicio: ancla.t,
        fin: fin.t,
        minutos: Math.round(minutos),
      });
      i = j;
    } else {
      i++;
    }
  }
  return paradas;
}

/**
 * @param {Array<{lat:number,lng:number,t:number,accuracy:number|null}>} crudos  ordenados por tiempo
 */
function armarRecorrido(crudos) {
  const puntos = limpiarPuntos(crudos);

  // Tramos continuos; entre tramos hubo más de SIN_SENAL_MIN sin puntos.
  const tramosCrudos = [];
  const huecos = [];
  let actual = [];
  for (const p of puntos) {
    const prev = actual[actual.length - 1];
    if (prev && (p.t - prev.t) / 60000 > SIN_SENAL_MIN) {
      tramosCrudos.push(actual);
      huecos.push({ desde: prev, hasta: p, minutos: Math.round((p.t - prev.t) / 60000) });
      actual = [];
    }
    actual.push(p);
  }
  if (actual.length) tramosCrudos.push(actual);

  let metros = 0;
  let segundosMovimiento = 0;
  for (const tramo of tramosCrudos) {
    for (let k = 1; k < tramo.length; k++) {
      const d = distanciaM(tramo[k - 1], tramo[k]);
      metros += d;
      // Se cuenta como "en movimiento" si avanzó a más de ~3 km/h
      const seg = (tramo[k].t - tramo[k - 1].t) / 1000;
      if (seg > 0 && d / seg > 0.8) segundosMovimiento += seg;
    }
  }

  const paradas = detectarParadas(puntos);
  const aTupla = (p) => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)), p.t];
  return {
    tramos: tramosCrudos.map((t) => simplificar(t).map(aTupla)),
    huecos: huecos.map((h) => ({
      desde: aTupla(h.desde),
      hasta: aTupla(h.hasta),
      minutos: h.minutos,
      metros: Math.round(distanciaM(h.desde, h.hasta)),
    })),
    paradas,
    resumen: {
      km: Number((metros / 1000).toFixed(1)),
      minutosMovimiento: Math.round(segundosMovimiento / 60),
      paradas: paradas.length,
      puntosRecibidos: crudos.length,
      puntosValidos: puntos.length,
      inicio: puntos[0]?.t ?? null,
      fin: puntos[puntos.length - 1]?.t ?? null,
    },
  };
}

/** Punto del recorrido más cercano en el tiempo (dentro de `maxMin`). */
function puntoMasCercano(puntos, t, maxMin = 10) {
  let mejor = null;
  let mejorDt = Infinity;
  for (const p of puntos) {
    const dt = Math.abs(p.t - t);
    if (dt < mejorDt) { mejorDt = dt; mejor = p; }
  }
  return mejor && mejorDt <= maxMin * 60000 ? mejor : null;
}

module.exports = {
  armarRecorrido,
  limpiarPuntos,
  simplificar,
  detectarParadas,
  puntoMasCercano,
  distanciaM,
  PRECISION_MAX_M,
};
