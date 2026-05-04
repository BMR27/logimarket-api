function errorHandler(err, req, res, next) {
  const msg = err?.message || String(err);
  console.error('Error:', msg, err?.stack);
  // detail incluido temporalmente para diagnóstico — remover después
  res.status(500).json({ error: 'Error interno del servidor', detail: msg });
}

module.exports = { errorHandler };
