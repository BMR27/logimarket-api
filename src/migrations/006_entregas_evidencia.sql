-- ============================================================
-- Migración 006: Tabla de evidencia de entrega por orden
-- Almacena foto del cliente y firma del receptor en base64
-- Ejecutar una sola vez en la base de datos de producción
-- ============================================================

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'lm5k' AND t.name = 'tb_entregas_evidencia'
)
BEGIN
  CREATE TABLE lm5k.tb_entregas_evidencia (
    id                INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    idOrden           INT NOT NULL,
    idUsuario         INT NOT NULL,                  -- mensajero que guardó
    nombreReceptor    NVARCHAR(200) NULL,            -- nombre de quien recibe
    fotoBase64        VARCHAR(MAX)   NULL,           -- foto del cliente (JPEG base64)
    firmaBase64       VARCHAR(MAX)   NULL,           -- firma del receptor (PNG base64)
    creationDate      DATETIME NOT NULL DEFAULT GETDATE(),
    lastModifiedDate  DATETIME NOT NULL DEFAULT GETDATE(),
    deleted           BIT      NOT NULL DEFAULT 0
  );

  -- Índice para consulta por orden
  CREATE INDEX IX_tb_entregas_evidencia_idOrden
    ON lm5k.tb_entregas_evidencia (idOrden)
    WHERE deleted = 0;

  PRINT 'Tabla lm5k.tb_entregas_evidencia creada correctamente.';
END
ELSE
BEGIN
  PRINT 'La tabla lm5k.tb_entregas_evidencia ya existe. No se realizaron cambios.';
END
GO
