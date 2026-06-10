-- ============================================================
-- Migracion 008: Solicitudes de cambio de precio por orden
-- Crea la tabla usada por /api/orders/:id/price-request
-- ============================================================

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'lm5k' AND t.name = 'SolicitudesCambioOrden'
)
BEGIN
  CREATE TABLE lm5k.SolicitudesCambioOrden (
    id                  INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    idOrden             INT NOT NULL,
    idUsuarioSolicita   INT NOT NULL,
    precioSolicitado    DECIMAL(18,2) NOT NULL,
    totalAutorizado     DECIMAL(18,2) NULL,
    motivoSolicitud     NVARCHAR(500) NULL,
    estadoSolicitud     NVARCHAR(30) NOT NULL DEFAULT 'pendiente',
    creationDate        DATETIME NOT NULL DEFAULT GETDATE(),
    lastModifiedDate    DATETIME NOT NULL DEFAULT GETDATE(),
    modifiedById        INT NOT NULL DEFAULT 0,
    deleted             BIT NOT NULL DEFAULT 0
  );

  CREATE INDEX IX_SolicitudesCambioOrden_Orden_Estado
    ON lm5k.SolicitudesCambioOrden (idOrden, estadoSolicitud, creationDate DESC)
    WHERE deleted = 0;

  PRINT 'Tabla lm5k.SolicitudesCambioOrden creada correctamente.';
END
ELSE
BEGIN
  PRINT 'La tabla lm5k.SolicitudesCambioOrden ya existe. No se realizaron cambios.';
END
GO
