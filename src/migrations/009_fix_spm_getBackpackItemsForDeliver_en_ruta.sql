-- Migration 009: corrige spm_getBackpackItemsForDeliver para mochilas "En Ruta" (State=2)
--
-- El SP elegía @IdBackpack entre mochilas State IN (1,2) (Asignada o En Ruta), pero el
-- SELECT final filtraba "tb_backpack.State = 1" a secas -- así que en cuanto el mensajero
-- aceptaba/iniciaba su mochila (pasa a State=2, "En Ruta"), el endpoint de entregas
-- (GET /api/backpacks/deliver/:idRepartidor/items) empezaba a devolver 0 filas para él,
-- aunque su mochila siguiera activa con órdenes pendientes reales.
--
-- La app (lib/providers/backpacks_provider.dart, loadMapItems) trata ese "vacío" como
-- señal de "el endpoint no trajo nada" y cae a un fallback que jala ítems por cada
-- idBackpack conocido vía el endpoint "admin" / caché local SQLite -- una ruta menos
-- confiable que puede mostrarle al mensajero contenido de mochilas ya cerradas si esos
-- ids quedan involucrados en algún momento (offline, reintentos, etc.), en vez de
-- simplemente devolver los ítems reales de su mochila activa en una sola consulta limpia.
--
-- Fecha: 2026-09-24
-- Aplicado directamente en producción (no hay runner de migraciones automático en este
-- repo); este archivo documenta el cambio para referencia/control de versiones.

IF OBJECT_ID('lm5k.spm_getBackpackItemsForDeliver', 'P') IS NOT NULL
BEGIN
  EXEC('
  ALTER PROCEDURE [lm5k].[spm_getBackpackItemsForDeliver]
    @IdRepartidor INT
  AS
  BEGIN
      DECLARE @IdBackpack INT;

      SELECT TOP 1 @IdBackpack = backpacks.Id
      FROM [lm5k].tb_backpacks AS backpacks
      WHERE backpacks.IdRepartidor = @IdRepartidor
      AND (backpacks.State = 1 OR backpacks.State = 2)
      AND ISNULL(backpacks.Deleted, 0) = 0
      ORDER BY backpacks.CreationDate DESC, backpacks.Id DESC;

      SELECT
          @IdBackpack AS "IdBackpack",
          tb_contenido.Id AS IdBackPackItem,
          tb_contenido.IdOrdenVenta,
          tb_ordenes.folioOrdenCliente AS FolioOrden,
          tb_status_orden.id AS IdStatusOrden,
          tb_status_orden.status AS StatusName,
          tb_ordenes.cliente AS NombreCliente,
          tb_contenido.Validation
      FROM [lm5k].tb_contenido_backpacks AS tb_contenido
      INNER JOIN [lm5k].tb_backpacks AS tb_backpack ON tb_backpack.id = tb_contenido.IdBackPack AND tb_backpack.Deleted = 0
      INNER JOIN [lm5k].OrdenesVenta AS tb_ordenes ON tb_ordenes.id = tb_contenido.IdOrdenVenta AND tb_ordenes.deleted = 0
      INNER JOIN [lm5k].StatusOrdenes AS tb_status_orden ON tb_status_orden.id = tb_ordenes.idStatus
      WHERE tb_contenido.IdBackPack = @IdBackpack
      AND (tb_backpack.State = 1 OR tb_backpack.State = 2)
      AND tb_contenido.Deleted = 0;
  END
  ');
  PRINT 'spm_getBackpackItemsForDeliver actualizado (incluye State=2 "En Ruta" en el filtro final).';
END
ELSE
  PRINT 'spm_getBackpackItemsForDeliver no existe, omitido.';
GO
