const { reportarExcepcion, reportarAviso } = require('./monitoreo');

function errorHandler(err, req, res, next) {
  const msg = err?.message || String(err);

  // El cliente (app móvil en red inestable) cerró la conexión antes de terminar de
  // enviar el body — no es un error del servidor, es benigno y no hay a quién
  // responderle (el socket ya está cerrado). Se loguea aparte, sin el ruido de un
  // "error interno" ni el intento fallido de escribir la respuesta.
  if (req.aborted || msg === 'request aborted' || err?.type === 'request.aborted') {
    console.warn('[request-aborted]', req.method, req.originalUrl);
    return;
  }

  // Body más grande que el límite (p. ej. una foto de evidencia muy pesada): es del cliente,
  // se responde 413 con un mensaje que la app muestra y se avisa como advertencia.
  if (err?.type === 'entity.too.large') {
    console.warn('[payload-too-large]', req.method, req.originalUrl, err.length, 'bytes');
    reportarAviso(`Petición demasiado grande (${Math.round((err.length || 0) / 1024)} KB, límite ${Math.round((err.limit || 0) / 1024)} KB)`, req, res, 413);
    return res.status(413).json({
      error: /\/evidencia/.test(req.originalUrl || '')
        ? 'La foto es demasiado pesada. Tómala de nuevo e intenta otra vez.'
        : 'La información enviada es demasiado grande.',
    });
  }

  console.error('Error:', msg, err?.stack);
  reportarExcepcion(err, req, res);
  // detail incluido temporalmente para diagnóstico — remover después
  res.status(500).json({ error: 'Error interno del servidor', detail: msg });
}

module.exports = { errorHandler };
