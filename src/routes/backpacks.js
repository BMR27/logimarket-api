const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

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

    const pool = await getPool();
    const result = await pool.request()
      .input('IdUsuario', sql.Int, idUsuario)
      .query('EXEC lm5k.spm_getBackpacks @IdUsuario');
    res.json(result.recordset);
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

    if (stateNumber === 3) {
      const isValidated = (item) => {
        const raw =
          item.Validation ??
          item.validation ??
          item.Validacion ??
          item.validacion ??
          item.isValidated;

        if (raw === true || raw === 1 || raw === '1') return true;
        if (typeof raw === 'string') {
          const normalized = raw.trim().toLowerCase();
          return normalized === 'true' || normalized === 'si' || normalized === 'yes';
        }
        return Number(raw ?? 0) === 1;
      };

      const itemsResult = await pool.request()
        .input('IdBackpack', sql.Int, idBackpack)
        .query('EXEC lm5k.spm_getBackpackItemsForAdmin @IdBackpack');

      const pendingItems = (itemsResult.recordset || []).filter(
        (item) => !isValidated(item)
      );

      if (pendingItems.length > 0) {
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
    if (items.length > 0) {
      try {
        const ids = items.map(i => i.IdOrdenVenta || i.idOrdenVenta).filter(id => id && id !== 0).join(',');
        if (ids) {
          const coordsResult = await pool.request()
            .query(`SELECT id, Latitud, Longitud FROM lm5k.OrdenesVenta WHERE id IN (${ids})`);
          const coordMap = {};
          for (const row of coordsResult.recordset) {
            coordMap[row.id] = { latitud: row.Latitud, longitud: row.Longitud };
          }
          for (const item of items) {
            const id = item.IdOrdenVenta || item.idOrdenVenta;
            item.Latitud = coordMap[id]?.latitud ?? null;
            item.Longitud = coordMap[id]?.longitud ?? null;
          }
        }
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
    const result = await pool.request()
      .input('IdRepartidor', sql.Int, idRepartidor)
      .query('EXEC lm5k.spm_getBackpackItemsForDeliver @IdRepartidor');

    const items = result.recordset;
    if (items.length > 0) {
      try {
        const ids = items.map(i => i.IdOrdenVenta || i.idOrdenVenta).filter(id => id && id !== 0).join(',');
        if (ids) {
          const coordsResult = await pool.request()
            .query(`SELECT id, Latitud, Longitud FROM lm5k.OrdenesVenta WHERE id IN (${ids})`);
          const coordMap = {};
          for (const row of coordsResult.recordset) {
            coordMap[row.id] = { latitud: row.Latitud, longitud: row.Longitud };
          }
          for (const item of items) {
            const id = item.IdOrdenVenta || item.idOrdenVenta;
            item.Latitud = coordMap[id]?.latitud ?? null;
            item.Longitud = coordMap[id]?.longitud ?? null;
          }
        }
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
        console.log('[VALIDATE] INTENTO 1: UPDATE por IdBackpackItem =', idItem);
        
        const updateResult = await pool.request()
          .input('IdBackpackItem', sql.Int, idItem)
          .input('Validation', sql.Int, 1)
          .query(`UPDATE lm5k.tb_contenido_backpacks SET Validation = @Validation WHERE IdBackpackItem = @IdBackpackItem`);

        if (updateResult.rowsAffected[0] > 0) {
          console.log('[VALIDATE] ✓ INTENTO 1 EXITOSO');
          return res.json({ success: true, method: 'IdBackpackItem' });
        }
        console.log('[VALIDATE] ✗ INTENTO 1: 0 filas afectadas');
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
