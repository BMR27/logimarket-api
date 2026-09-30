const { sql } = require('../config/database');

// El historial de ubicaciones crece con cada ping del celular. Se conservan
// RETENCION_UBICACION_DIAS días (90 por defecto) y se borra lo anterior en
// bloques chicos para no bloquear la tabla. LIMPIAR_HISTORIAL_UBICACION=0 lo apaga.
const BLOQUE = 5000;
const CADA_MS = 6 * 60 * 60 * 1000;

function iniciarLimpiezaHistorialUbicacion(getPool) {
  if (process.env.LIMPIAR_HISTORIAL_UBICACION === '0') return null;
  const dias = Math.max(30, Number(process.env.RETENCION_UBICACION_DIAS) || 90);

  const limpiar = async () => {
    try {
      const pool = await getPool();
      let borrados = 0;
      for (let i = 0; i < 200; i++) {
        const r = await pool.request()
          .input('dias', sql.Int, dias)
          .query(`
            IF OBJECT_ID(N'lm5k.tb_mensajero_ubicacion_history') IS NULL
              SELECT 0 AS n
            ELSE
            BEGIN
              DELETE TOP (${BLOQUE}) FROM lm5k.tb_mensajero_ubicacion_history
              WHERE createdAt < DATEADD(DAY, -@dias, CAST(GETDATE() AS DATE));
              SELECT @@ROWCOUNT AS n;
            END
          `);
        const n = Number(r.recordset?.[0]?.n) || 0;
        borrados += n;
        if (n < BLOQUE) break;
      }
      if (borrados) console.log(`[ubicacion] historial: ${borrados} puntos de más de ${dias} días borrados`);
    } catch (err) {
      console.error('[ubicacion] limpieza de historial:', err?.message);
    }
  };

  const timer = setInterval(limpiar, CADA_MS);
  timer.unref?.();
  setTimeout(limpiar, 60 * 1000).unref?.();
  return timer;
}

module.exports = { iniciarLimpiezaHistorialUbicacion };
