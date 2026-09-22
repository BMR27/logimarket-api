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

  console.error('Error:', msg, err?.stack);
  // detail incluido temporalmente para diagnóstico — remover después
  res.status(500).json({ error: 'Error interno del servidor', detail: msg });
}

module.exports = { errorHandler };
