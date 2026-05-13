const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

let schemaCache = null;
let schemaCacheAt = 0;
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

async function getBlockingBackpacks(pool, idRepartidor, excludeBackpackId = null) {
  const request = pool.request().input('IdRepartidor', sql.Int, Number(idRepartidor));
  if (excludeBackpackId) {
    request.input('ExcludeBackpackId', sql.Int, Number(excludeBackpackId));
  }

  const result = await request.query(`
    SELECT
      b.Id,
      b.State,
      SUM(CASE WHEN cb.IdOrdenVenta IS NOT NULL AND ISNULL(cb.Validation, 0) <> 1 THEN 1 ELSE 0 END) AS pendientesRetorno
    FROM lm5k.tb_backpacks b WITH (NOLOCK)
    LEFT JOIN lm5k.tb_contenido_backpacks cb WITH (NOLOCK)
      ON cb.IdBackPack = b.Id AND ISNULL(cb.Deleted, 0) = 0
    WHERE ISNULL(b.Deleted, 0) = 0
      AND b.IdRepartidor = @IdRepartidor
      ${excludeBackpackId ? 'AND b.Id <> @ExcludeBackpackId' : ''}
    GROUP BY b.Id, b.State
    HAVING
      b.State IN (1, 2)
      OR (b.State = 3 AND SUM(CASE WHEN cb.IdOrdenVenta IS NOT NULL AND ISNULL(cb.Validation, 0) <> 1 THEN 1 ELSE 0 END) > 0)
    ORDER BY b.Id DESC
  `);

  return result.recordset || [];
}

async function getTableColumnsMap(pool, tableName) {
  const result = await pool.request()
    .input('TableName', sql.NVarChar(128), tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'lm5k' AND TABLE_NAME = @TableName
    `);

  const columns = new Map();
  for (const row of result.recordset || []) {
    const name = String(row.COLUMN_NAME || '').trim();
    if (name) columns.set(name.toLowerCase(), name);
  }
  return columns;
}

function pickColumn(columnsMap, candidates) {
  for (const candidate of candidates) {
    const found = columnsMap.get(String(candidate).toLowerCase());
    if (found) return found;
  }
  return null;
}

function getBackpackState(backpackRow) {
  const rawState = backpackRow?.State
    ?? backpackRow?.state
    ?? backpackRow?.Estado
    ?? backpackRow?.estado
    ?? backpackRow?.Status
    ?? backpackRow?.status
    ?? backpackRow?.IdEstado
    ?? backpackRow?.idEstado;

  const parsed = Number(rawState);
  if (Number.isFinite(parsed)) return parsed;

  const rawText = String(
    backpackRow?.StateName
      ?? backpackRow?.stateName
      ?? backpackRow?.EstadoNombre
      ?? backpackRow?.estadoNombre
      ?? backpackRow?.Estatus
      ?? backpackRow?.estatus
      ?? ''
  )
    .trim()
    .toLowerCase();

  if (!rawText) return 0;
  if (rawText.includes('asign')) return 1;
  if (rawText.includes('ruta')) return 2;
  if (rawText.includes('termin') || rawText.includes('finaliz')) return 3;
  if (rawText.includes('cerr') || rawText.includes('cancel')) return 4;

  return 0;
}

function isActiveBackpack(backpackRow) {
  const state = getBackpackState(backpackRow);
  return state === 1 || state === 2;
}

async function getBackpacksFallback(pool, idUsuario) {
  const result = await pool.request()
    .input('IdUsuario', sql.Int, idUsuario)
    .query(`
      SELECT
        b.Id,
        b.IdRepartidor,
        ISNULL(mu.nombres + ' ' + mu.apellidoPaterno, '') AS NombreRepartidor,
        b.CreationDate,
        b.State,
        CASE b.State
          WHEN 1 THEN 'Asignada'
          WHEN 2 THEN 'En Ruta'
          WHEN 3 THEN 'Terminada'
          WHEN 4 THEN 'Cerrada'
          ELSE 'Desconocido'
        END AS StateName,
        COUNT(cb.IdOrdenVenta) AS TotalOrders,
        SUM(CASE WHEN ISNULL(cb.Validation, 0) = 1 THEN 1 ELSE 0 END) AS ProgressOrders
      FROM lm5k.tb_backpacks b WITH (NOLOCK)
      LEFT JOIN lm5k.tb_contenido_backpacks cb WITH (NOLOCK)
        ON cb.IdBackPack = b.Id AND ISNULL(cb.Deleted, 0) = 0
      LEFT JOIN lm5k.Usuarios mu WITH (NOLOCK)
        ON mu.id = b.IdRepartidor
      WHERE ISNULL(b.Deleted, 0) = 0
        AND b.IdRepartidor = @IdUsuario
      GROUP BY b.Id, b.IdRepartidor, mu.nombres, mu.apellidoPaterno, b.CreationDate, b.State
      ORDER BY b.Id DESC
    `);

  return result.recordset || [];
}

async function getUserBackpacks(pool, idUsuario) {
  const spResult = await pool.request()
    .input('IdUsuario', sql.Int, idUsuario)
    .query('EXEC lm5k.spm_getBackpacks @IdUsuario');

  const spRows = spResult.recordset || [];
  if (spRows.length > 0) return spRows;

  return getBackpacksFallback(pool, idUsuario);
}

async function getSchemaInfo(pool) {
  const now = Date.now();
  if (schemaCache && now - schemaCacheAt < SCHEMA_CACHE_TTL_MS) {
    return schemaCache;
  }

  const [backpackCols, orderCols] = await Promise.all([
    getTableColumnsMap(pool, 'tb_contenido_backpacks'),
    getTableColumnsMap(pool, 'OrdenesVenta'),
  ]);

  schemaCache = {
    backpackItemIdColumn: pickColumn(backpackCols, ['IdBackpackItem', 'IdBackPackItem', 'IdContenidoMochila']),
    orderLatitudeColumn: pickColumn(orderCols, ['Latitud', 'Latitude']),
    orderLongitudeColumn: pickColumn(orderCols, ['Longitud', 'Longitude', 'Lng']),
    orderStreetColumn: pickColumn(orderCols, ['Calle', 'Direccion']),
    orderNumExteriorColumn: pickColumn(orderCols, ['NumExterior', 'NumeroExterior']),
    orderColoniaColumn: pickColumn(orderCols, ['Colonia']),
    orderMunicipioColumn: pickColumn(orderCols, ['MunicipioDelegacion', 'Municipio']),
    orderEstadoColumn: pickColumn(orderCols, ['Estado']),
    orderCodigoPostalColumn: pickColumn(orderCols, ['CodigoPostal', 'CP']),
  };
  schemaCacheAt = now;
  return schemaCache;
}

async function enrichItemsWithOrderData(pool, items) {
  const ids = [...new Set(items
    .map((i) => Number(i.IdOrdenVenta || i.idOrdenVenta || 0))
    .filter((id) => Number.isInteger(id) && id > 0))]
    .join(',');

  if (!ids) return;

  const schemaInfo = await getSchemaInfo(pool);
  const selectCols = ['id'];

  if (schemaInfo.orderLatitudeColumn) {
    selectCols.push(`[${schemaInfo.orderLatitudeColumn}] AS Latitud`);
  }
  if (schemaInfo.orderLongitudeColumn) {
    selectCols.push(`[${schemaInfo.orderLongitudeColumn}] AS Longitud`);
  }
  if (schemaInfo.orderStreetColumn) {
    selectCols.push(`[${schemaInfo.orderStreetColumn}] AS Calle`);
  }
  if (schemaInfo.orderNumExteriorColumn) {
    selectCols.push(`[${schemaInfo.orderNumExteriorColumn}] AS NumExterior`);
  }
  if (schemaInfo.orderColoniaColumn) {
    selectCols.push(`[${schemaInfo.orderColoniaColumn}] AS Colonia`);
  }
  if (schemaInfo.orderMunicipioColumn) {
    selectCols.push(`[${schemaInfo.orderMunicipioColumn}] AS MunicipioDelegacion`);
  }
  if (schemaInfo.orderEstadoColumn) {
    selectCols.push(`[${schemaInfo.orderEstadoColumn}] AS Estado`);
  }
  if (schemaInfo.orderCodigoPostalColumn) {
    selectCols.push(`[${schemaInfo.orderCodigoPostalColumn}] AS CodigoPostal`);
  }

  const coordsResult = await pool.request()
    .query(`SELECT ${selectCols.join(', ')} FROM lm5k.OrdenesVenta WHERE id IN (${ids})`);

  const coordMap = {};
  for (const row of coordsResult.recordset || []) {
    coordMap[row.id] = {
      latitud: row.Latitud ?? null,
      longitud: row.Longitud ?? null,
      calle: row.Calle ?? null,
      numExterior: row.NumExterior ?? null,
      colonia: row.Colonia ?? null,
      municipio: row.MunicipioDelegacion ?? null,
      estado: row.Estado ?? null,
      codigoPostal: row.CodigoPostal ?? null,
    };
  }

  for (const item of items) {
    const id = Number(item.IdOrdenVenta || item.idOrdenVenta || 0);
    const d = coordMap[id];
    item.Latitud = d?.latitud ?? null;
    item.Longitud = d?.longitud ?? null;
    item.Calle = d?.calle ?? null;
    item.NumExterior = d?.numExterior ?? null;
    item.Colonia = d?.colonia ?? null;
    item.MunicipioDelegacion = d?.municipio ?? null;
    item.Estado = d?.estado ?? null;
    item.CodigoPostal = d?.codigoPostal ?? null;
  }
}

// ── Utilidad: envío de mensaje WhatsApp/SMS por número ──────────────────────
// Configura TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM en Railway para activar envíos reales.
// Si no están configuradas, solo loguea.
async function sendMessage(to, body) {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM; // ej: whatsapp:+14155238886 o +1234567890

  if (!sid || !token || !from) {
    console.log(`[MSG no enviado — sin credenciales Twilio] Para: ${to} | ${body}`);
    return { sent: false, reason: 'no_credentials' };
  }

  try {
    const twilio = require('twilio')(sid, token);
    const msg = await twilio.messages.create({
      body,
      from,
      to: from.startsWith('whatsapp:') ? `whatsapp:+52${to.replace(/\D/g, '')}` : `+52${to.replace(/\D/g, '')}`,
    });
    return { sent: true, sid: msg.sid };
  } catch (e) {
    console.error(`[MSG error] ${to}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

/**
 * GET /api/backpacks/:idUsuario
 * Obtiene todas las mochilas del usuario (spm_getBackpacks)
 */
router.get('/:idUsuario', async (req, res, next) => {
  try {
    const idUsuario = parseInt(req.params.idUsuario, 10);
    if (isNaN(idUsuario)) return res.status(400).json({ error: 'IdUsuario inválido' });
    const includeClosed = String(req.query.includeClosed || '0') === '1';

    const pool = await getPool();
    const backpacks = await getUserBackpacks(pool, idUsuario);
    
    // Filtrar mochilas por estado
    const activeBackpacks = backpacks.filter((b) => isActiveBackpack(b));
    const nonClosedBackpacks = backpacks.filter((b) => getBackpackState(b) !== 4);

    const filtered = includeClosed
      ? backpacks
      : (activeBackpacks.length > 0 ? activeBackpacks : nonClosedBackpacks);

    res.json(filtered);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/backpacks
 * Body: { idRepartidor, idLider, orderIds (CSV string) }
 * Crea una nueva mochila (spm_insert_backpack)
 */
router.post('/', async (req, res, next) => {
  try {
    const { idRepartidor, idLider, orderIds } = req.body;
    if (!idRepartidor || !idLider || !orderIds) {
      return res.status(400).json({ error: 'idRepartidor, idLider y orderIds son requeridos' });
    }

    const fechaActual = new Date().toISOString().slice(0, 10);
    const pool = await getPool();

    const blockingBackpacks = await getBlockingBackpacks(pool, idRepartidor);
    if (blockingBackpacks.length > 0) {
      return res.status(409).json({
        error: 'El mensajero seleccionado tiene una Mochila Activa, favor de validar para continuar',
        code: 'MOCHILA_PENDIENTE',
      });
    }

    const result = await pool.request()
      .input('IdRepartidor', sql.Int, idRepartidor)
      .input('IdLider', sql.Int, idLider)
      .input('FechaActual', sql.NVarChar(50), fechaActual)
      .input('OrdersIds', sql.NVarChar(sql.MAX), orderIds)
      .query('EXEC lm5k.spm_insert_backpack @IdRepartidor, @IdLider, @FechaActual, @OrdersIds');

    const row = result.recordset[0];
    if (row && row.result === 'error') {
      return res.status(500).json({ error: row.message || 'Error al crear mochila' });
    }
    res.status(201).json({ success: true, result: row });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/backpacks/:id
 * Body: { state }  (1=Asignada, 2=En Ruta, 3=Terminada, 4=Cancelada)
 * Actualiza estado de una mochila (spm_update_backpack)
 */
router.put('/:id', async (req, res, next) => {
  try {
    const idBackpack = parseInt(req.params.id, 10);
    const stateNumber = Number(req.body?.state);
    if (isNaN(idBackpack) || Number.isNaN(stateNumber)) {
      return res.status(400).json({ error: 'id y state son requeridos' });
    }

    if (![1, 2, 3, 4].includes(stateNumber)) {
      return res.status(400).json({ error: 'state inválido' });
    }

    const pool = await getPool();

    if (stateNumber === 2) {
      const currentBackpackRes = await pool.request()
        .input('IdBackpack', sql.Int, idBackpack)
        .query(`
          SELECT Id, IdRepartidor
          FROM lm5k.tb_backpacks
          WHERE Id = @IdBackpack AND ISNULL(Deleted, 0) = 0
        `);

      if (!currentBackpackRes.recordset.length) {
        return res.status(404).json({ error: 'Mochila no encontrada' });
      }

      const idRepartidor = Number(currentBackpackRes.recordset[0].IdRepartidor ?? 0);
      if (idRepartidor > 0) {
        const blockingBackpacks = await getBlockingBackpacks(pool, idRepartidor, idBackpack);
        if (blockingBackpacks.length > 0) {
          return res.status(409).json({
            error: 'El mensajero seleccionado tiene una Mochila Activa, favor de validar para continuar',
            code: 'MOCHILA_PENDIENTE',
          });
        }
      }
    }

    if (stateNumber === 3) {
      // Valida contra la tabla base para que coincida con el flujo de escaneo por folio.
      const pendingResult = await pool.request()
        .input('IdBackpack', sql.Int, idBackpack)
        .query(`
          SELECT COUNT(1) AS pendingCount
          FROM lm5k.tb_contenido_backpacks cb
          WHERE cb.IdBackPack = @IdBackpack
            AND cb.Deleted = 0
            AND ISNULL(cb.Validation, 0) <> 1
        `);

      const pendingCount = Number(pendingResult.recordset?.[0]?.pendingCount ?? 0);
      if (pendingCount > 0) {
        return res.status(400).json({
          error: 'Debes validar todas las entregas antes de finalizar la mochila',
        });
      }
    }

    const result = await pool.request()
      .input('_IdBackpack', sql.Int, idBackpack)
      .input('_State', sql.Int, stateNumber)
      .query('EXEC lm5k.spm_update_backpack @_IdBackpack, @_State');

    const row = result.recordset?.[0];
    if (row && row.result === 'non-affected') {
      return res.status(404).json({ error: 'Mochila no encontrada' });
    }

    // ── Mensajes masivos al aceptar mochila (state 2 = En Ruta) ─────────────
    if (stateNumber === 2) {
      try {
        const ordersResult = await pool.request()
          .input('IdBackpack', sql.Int, idBackpack)
          .query(`
            SELECT ov.folioOrdenCliente, ov.telefonoPrincipal, ov.cliente
            FROM lm5k.tb_contenido_backpacks cb
            INNER JOIN lm5k.OrdenesVenta ov ON ov.id = cb.IdOrdenVenta
            WHERE cb.IdBackPack = @IdBackpack AND cb.Deleted = 0
          `);

        const orders = ordersResult.recordset || [];
        const messagingResults = [];

        for (const order of orders) {
          const phone = (order.telefonoPrincipal || '').replace(/\D/g, '');
          if (!phone) continue;

          const msg = `Hola ${order.cliente}, tu pedido con folio ${order.folioOrdenCliente} está en camino y será entregado en breve. ¡Gracias por tu confianza!`;
          const r = await sendMessage(phone, msg);
          messagingResults.push({ folio: order.folioOrdenCliente, phone, ...r });
        }

        return res.json({ success: true, messaging: messagingResults });
      } catch (msgErr) {
        console.error('Error en mensajes masivos:', msgErr?.message || msgErr);
        // No falla la respuesta principal
      }
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/backpacks/:id/items
 * Obtiene ítems de una mochila (vista admin) — spm_getBackpackItemsForAdmin
 */
router.get('/:id/items', async (req, res, next) => {
  try {
    const idBackpack = parseInt(req.params.id, 10);
    if (isNaN(idBackpack)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    // Obtener ítems base
    const result = await pool.request()
      .input('IdBackpack', sql.Int, idBackpack)
      .query('EXEC lm5k.spm_getBackpackItemsForAdmin @IdBackpack');

    // Enriquecer con lat/lng de OrdenesVenta
    const items = result.recordset;

    // Fuerza Validation desde tabla base para evitar desalineacion con SP.
    if (items.length > 0) {
      try {
        const validationResult = await pool.request()
          .input('IdBackpack', sql.Int, idBackpack)
          .query(`
            SELECT IdOrdenVenta, ISNULL(Validation, 0) AS Validation
            FROM lm5k.tb_contenido_backpacks
            WHERE IdBackPack = @IdBackpack AND Deleted = 0
          `);

        const byOrder = new Map();
        for (const row of validationResult.recordset || []) {
          if (row.IdOrdenVenta) byOrder.set(Number(row.IdOrdenVenta), Number(row.Validation || 0));
        }

        for (const item of items) {
          const itemOrder = Number(item.IdOrdenVenta || item.idOrdenVenta || 0);
          const realValidation = byOrder.get(itemOrder);
          if (realValidation !== undefined) {
            item.Validation = realValidation;
          }
        }
      } catch (validationErr) {
        console.warn('[backpacks] No se pudo sincronizar Validation:', validationErr.message);
      }
    }

    if (items.length > 0) {
      try {
        await enrichItemsWithOrderData(pool, items);
      } catch (coordErr) {
        console.warn('[backpacks] No se pudo enriquecer lat/lng:', coordErr.message);
        // No falla el endpoint principal — items se devuelven sin coordenadas
      }
    }

    res.json(items);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/backpacks/deliver/:idRepartidor/items
 * Obtiene ítems asignados al repartidor — spm_getBackpackItemsForDeliver
 */
router.get('/deliver/:idRepartidor/items', async (req, res, next) => {
  try {
    const idRepartidor = parseInt(req.params.idRepartidor, 10);
    if (isNaN(idRepartidor)) return res.status(400).json({ error: 'IdRepartidor inválido' });

    const pool = await getPool();
    const activeBackpacks = await getUserBackpacks(pool, idRepartidor);

    const parsedBackpacks = activeBackpacks || [];
    const activeRows = parsedBackpacks.filter((b) => isActiveBackpack(b));
    const nonClosedRows = parsedBackpacks.filter((b) => getBackpackState(b) !== 4);
    const sourceRows = activeRows.length > 0 ? activeRows : nonClosedRows;

    const activeBackpackIds = new Set(
      sourceRows
        .map((b) => Number(b.Id ?? b.id ?? 0))
        .filter((id) => Number.isInteger(id) && id > 0)
    );

    const result = await pool.request()
      .input('IdRepartidor', sql.Int, idRepartidor)
      .query('EXEC lm5k.spm_getBackpackItemsForDeliver @IdRepartidor');

    let items = result.recordset || [];
    if (activeBackpackIds.size > 0) {
      items = items.filter((item) => {
        const idBackpack = Number(item.IdBackPack ?? item.IdBackpack ?? item.idBackpack ?? 0);
        return activeBackpackIds.has(idBackpack);
      });
    } else {
      items = [];
    }

    // Fuerza Validation desde tabla base para que el mensajero vea estado persistente.
    if (items.length > 0) {
      try {
        const orderIds = items
          .map((i) => Number(i.IdOrdenVenta || i.idOrdenVenta || 0))
          .filter((id) => Number.isInteger(id) && id > 0);

        if (orderIds.length > 0) {
          const idsCsv = [...new Set(orderIds)].join(',');
          const validationResult = await pool.request().query(`
            SELECT IdOrdenVenta, MAX(ISNULL(Validation, 0)) AS Validation
            FROM lm5k.tb_contenido_backpacks
            WHERE Deleted = 0 AND IdOrdenVenta IN (${idsCsv})
            GROUP BY IdOrdenVenta
          `);

          const byOrder = new Map();
          for (const row of validationResult.recordset || []) {
            byOrder.set(Number(row.IdOrdenVenta), Number(row.Validation || 0));
          }

          for (const item of items) {
            const itemOrder = Number(item.IdOrdenVenta || item.idOrdenVenta || 0);
            const realValidation = byOrder.get(itemOrder);
            if (realValidation !== undefined) {
              item.Validation = realValidation;
            }
          }
        }
      } catch (validationErr) {
        console.warn('[backpacks] No se pudo sincronizar Validation deliver:', validationErr.message);
      }
    }

    if (items.length > 0) {
      try {
        await enrichItemsWithOrderData(pool, items);
      } catch (coordErr) {
        console.warn('[backpacks] No se pudo enriquecer lat/lng:', coordErr.message);
        // No falla el endpoint principal — items se devuelven sin coordenadas
      }
    }

    res.json(items);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/backpacks/items/:id
 * Elimina un ítem de la mochila (spm_delete_item_from_backpack)
 */
router.delete('/items/:id', async (req, res, next) => {
  try {
    const idBackpackItem = parseInt(req.params.id, 10);
    if (isNaN(idBackpackItem)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdBackpackItem', sql.Int, idBackpackItem)
      .query('EXEC lm5k.spm_delete_item_from_backpack @IdBackpackItem');

    const row = result.recordset[0];
    if (!row || row.result === false || row.result === 'false') {
      return res.status(404).json({ error: 'Ítem no encontrado' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/backpacks/:id/items/validate-folio
 * Valida un item por folio dentro de una mochila especifica.
 * Body: { folio: string }
 */
router.put('/:id/items/validate-folio', async (req, res, next) => {
  try {
    const idBackpack = parseInt(req.params.id, 10);
    const folio = String(req.body?.folio || '').trim();

    if (isNaN(idBackpack) || idBackpack <= 0) {
      return res.status(400).json({ error: 'IdBackpack invalido' });
    }
    if (!folio) {
      return res.status(400).json({ error: 'Folio requerido' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('IdBackpack', sql.Int, idBackpack)
      .input('Folio', sql.NVarChar(100), folio)
      .query(`
        UPDATE cb
        SET cb.Validation = 1
        FROM lm5k.tb_contenido_backpacks cb
        INNER JOIN lm5k.OrdenesVenta ov ON ov.id = cb.IdOrdenVenta
        WHERE cb.IdBackPack = @IdBackpack
          AND cb.Deleted = 0
          AND LTRIM(RTRIM(ov.folioOrdenCliente)) = @Folio
      `);

    const affected = result.rowsAffected?.[0] || 0;
    if (affected <= 0) {
      return res.status(404).json({ error: 'Item no encontrado en la mochila para ese folio' });
    }

    return res.json({ success: true, updated: affected, method: 'backpack+folio' });
  } catch (err) {
    next(err);
  }
});

/**
/**
 * PUT /api/backpacks/items/:id/validate
 * Valida un ítem por escaneo
 * ID puede ser: IdBackpackItem, folio de orden, IdOrdenVenta, etc
 */
router.put('/items/:id/validate', async (req, res, next) => {
  try {
    const idOrFolio = req.params.id;
    console.log('[VALIDATE] ===== INICIO VALIDACIÓN =====');
    console.log('[VALIDATE] ID/Folio recibido:', idOrFolio);
    
    if (!idOrFolio || idOrFolio.trim() === '') {
      return res.status(400).json({ error: 'ID o Folio requerido' });
    }

    const pool = await getPool();
    const idItem = parseInt(idOrFolio, 10);
    const isNumericId = !isNaN(idItem) && idItem > 0;

    console.log('[VALIDATE] ¿Es ID numérico?:', isNumericId);

    // INTENTO 1: Si es numérico, busca por IdBackpackItem
    if (isNumericId) {
      try {
        const schemaInfo = await getSchemaInfo(pool);
        if (!schemaInfo.backpackItemIdColumn) {
          console.log('[VALIDATE] INTENTO 1 OMITIDO: no existe columna IdBackpackItem/IdBackPackItem');
        } else {
          console.log('[VALIDATE] INTENTO 1: UPDATE por', schemaInfo.backpackItemIdColumn, '=', idItem);

          const updateResult = await pool.request()
            .input('IdBackpackItem', sql.Int, idItem)
            .input('Validation', sql.Int, 1)
            .query(`UPDATE lm5k.tb_contenido_backpacks SET Validation = @Validation WHERE [${schemaInfo.backpackItemIdColumn}] = @IdBackpackItem`);

          if (updateResult.rowsAffected[0] > 0) {
            console.log('[VALIDATE] ✓ INTENTO 1 EXITOSO');
            return res.json({ success: true, method: schemaInfo.backpackItemIdColumn });
          }
          console.log('[VALIDATE] ✗ INTENTO 1: 0 filas afectadas');
        }
      } catch (err1) {
        console.log('[VALIDATE] ✗ INTENTO 1 ERROR:', err1.message);
      }

      // INTENTO 2: Si es numérico, busca por IdOrdenVenta
      try {
        console.log('[VALIDATE] INTENTO 2: UPDATE por IdOrdenVenta =', idItem);
        
        const updateResult = await pool.request()
          .input('IdOrdenVenta', sql.Int, idItem)
          .input('Validation', sql.Int, 1)
          .query(`UPDATE lm5k.tb_contenido_backpacks SET Validation = @Validation WHERE IdOrdenVenta = @IdOrdenVenta`);
        
        if (updateResult.rowsAffected[0] > 0) {
          console.log('[VALIDATE] ✓ INTENTO 2 EXITOSO');
          return res.json({ success: true, method: 'IdOrdenVenta' });
        }
        console.log('[VALIDATE] ✗ INTENTO 2: 0 filas afectadas');
      } catch (err2) {
        console.log('[VALIDATE] ✗ INTENTO 2 ERROR:', err2.message);
      }
    }

    // INTENTO 3: Buscar por FolioOrden (string) - ESTE ES EL MÁS PROBABLE
    try {
      console.log('[VALIDATE] INTENTO 3: UPDATE por FolioOrden =', idOrFolio);
      
      const updateResult = await pool.request()
        .input('Folio', sql.NVarChar(50), idOrFolio.trim())
        .input('Validation', sql.Int, 1)
        .query(`UPDATE lm5k.tb_contenido_backpacks SET Validation = @Validation WHERE FolioOrden = @Folio OR IdOrdenVenta = (SELECT id FROM lm5k.OrdenesVenta WHERE folioOrdenCliente = @Folio)`);
      
      console.log('[VALIDATE] Filas afectadas:', updateResult.rowsAffected[0]);
      
      if (updateResult.rowsAffected[0] > 0) {
        console.log('[VALIDATE] ✓ INTENTO 3 EXITOSO por FolioOrden');
        return res.json({ success: true, method: 'FolioOrden' });
      }
      console.log('[VALIDATE] ✗ INTENTO 3: 0 filas afectadas');
    } catch (err3) {
      console.log('[VALIDATE] ✗ INTENTO 3 ERROR:', err3.message);
    }

    // INTENTO 4: Buscar en tabla alternativa
    try {
      console.log('[VALIDATE] INTENTO 4: UPDATE contenido_mochilas');
      
      const altResult = await pool.request()
        .input('IdContenido', sql.Int, idItem)
        .query(`UPDATE lm5k.contenido_mochilas SET Validacion = 1, FechaValidacion = GETDATE() WHERE IdContenidoMochila = @IdContenido`);
      
      if (altResult.rowsAffected[0] > 0) {
        console.log('[VALIDATE] ✓ INTENTO 4 EXITOSO');
        return res.json({ success: true, method: 'contenido_mochilas' });
      }
    } catch (err4) {
      console.log('[VALIDATE] ✗ INTENTO 4 ERROR:', err4.message);
    }

    console.log('[VALIDATE] ✗ FALLO: No se pudo validar. Item:', idOrFolio);
    return res.status(404).json({ 
      error: 'Item no encontrado en BD. Verifica el folio.',
      sent: idOrFolio
    });
    
  } catch (err) {
    console.error('[VALIDATE] ERROR FATAL:', err.message);
    next(err);
  }
});

module.exports = router;
