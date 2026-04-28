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
      const itemsResult = await pool.request()
        .input('IdBackpack', sql.Int, idBackpack)
        .query('EXEC lm5k.spm_getBackpackItemsForAdmin @IdBackpack');

      const pendingItems = (itemsResult.recordset || []).filter(
        (item) => Number(item.Validation ?? item.validation ?? 0) !== 1
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
/**
 * PUT /api/backpacks/items/:id/validate
 * Valida un ítem por escaneo
 * ID puede ser: IdBackpackItem, IdOrdenVenta, o IdContenido
 */
router.put('/items/:id/validate', async (req, res, next) => {
  try {
    const idItem = parseInt(req.params.id, 10);
    console.log('[VALIDATE] ===== INICIO VALIDACIÓN =====');
    console.log('[VALIDATE] ID recibido:', req.params.id);
    console.log('[VALIDATE] ID parseado:', idItem);
    
    if (isNaN(idItem) || idItem <= 0) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const pool = await getPool();
    let updated = false;

    // INTENTO 1: UPDATE por IdBackpackItem (clave principal de tb_contenido_backpacks)
    try {
      console.log('[VALIDATE] INTENTO 1: UPDATE por IdBackpackItem');
      const updateResult = await pool.request()
        .input('IdBackpackItem', sql.Int, idItem)
        .input('Validation', sql.Int, 1)
        .query(`
          UPDATE lm5k.tb_contenido_backpacks 
          SET Validation = @Validation
          WHERE IdBackpackItem = @IdBackpackItem
        `);

      console.log('[VALIDATE] Filas afectadas:', updateResult.rowsAffected[0]);
      
      if (updateResult.rowsAffected[0] > 0) {
        updated = true;
        console.log('[VALIDATE] ✓ UPDATE por IdBackpackItem EXITOSO');
      } else {
        console.log('[VALIDATE] ✗ No hay IdBackpackItem = ' + idItem);
      }
    } catch (err1) {
      console.log('[VALIDATE] ✗ INTENTO 1 ERROR:', err1.message);
    }

    // INTENTO 2: Si no funciona, intenta UPDATE por IdOrdenVenta
    if (!updated) {
      try {
        console.log('[VALIDATE] INTENTO 2: UPDATE por IdOrdenVenta');
        const updateResult = await pool.request()
          .input('IdOrdenVenta', sql.Int, idItem)
          .input('Validation', sql.Int, 1)
          .query(`
            UPDATE lm5k.tb_contenido_backpacks 
            SET Validation = @Validation
            WHERE IdOrdenVenta = @IdOrdenVenta
          `);
        
        console.log('[VALIDATE] Filas afectadas:', updateResult.rowsAffected[0]);
        
        if (updateResult.rowsAffected[0] > 0) {
          updated = true;
          console.log('[VALIDATE] ✓ UPDATE por IdOrdenVenta EXITOSO');
        } else {
          console.log('[VALIDATE] ✗ No hay IdOrdenVenta = ' + idItem);
        }
      } catch (err2) {
        console.log('[VALIDATE] ✗ INTENTO 2 ERROR:', err2.message);
      }
    }

    // INTENTO 3: Tabla alternativa contenido_mochilas
    if (!updated) {
      try {
        console.log('[VALIDATE] INTENTO 3: UPDATE contenido_mochilas por IdContenidoMochila');
        const altResult = await pool.request()
          .input('IdContenido', sql.Int, idItem)
          .query(`
            UPDATE lm5k.contenido_mochilas 
            SET Validacion = 1, FechaValidacion = GETDATE()
            WHERE IdContenidoMochila = @IdContenido
          `);
        
        console.log('[VALIDATE] Filas afectadas:', altResult.rowsAffected[0]);
        
        if (altResult.rowsAffected[0] > 0) {
          updated = true;
          console.log('[VALIDATE] ✓ UPDATE contenido_mochilas EXITOSO');
        } else {
          console.log('[VALIDATE] ✗ No hay IdContenidoMochila = ' + idItem);
        }
      } catch (err3) {
        console.log('[VALIDATE] ✗ INTENTO 3 ERROR:', err3.message);
      }
    }

    // INTENTO 4: Ejecutar SP si existe
    if (!updated) {
      try {
        console.log('[VALIDATE] INTENTO 4: Ejecutar spm_updateBackpackItemValidation');
        const spResult = await pool.request()
          .input('IdBackpackItem', sql.Int, idItem)
          .query('EXEC lm5k.spm_updateBackpackItemValidation @IdBackpackItem');
        
        console.log('[VALIDATE] SP retornó:', spResult.recordset);
        updated = true;
        console.log('[VALIDATE] ✓ SP EXITOSO');
      } catch (err4) {
        console.log('[VALIDATE] ✗ INTENTO 4 ERROR:', err4.message);
      }
    }

    if (!updated) {
      console.log('[VALIDATE] ✗ FALLO TOTAL - Ningún método funcionó para ID:', idItem);
      return res.status(500).json({ 
        error: 'No se pudo validar el ítem. Verifica los logs.' 
      });
    }

    console.log('[VALIDATE] ✓ VALIDACIÓN EXITOSA');
    res.json({ success: true });
    
  } catch (err) {
    console.error('[VALIDATE] ERROR FATAL:', err.message);
    console.error('[VALIDATE] STACK:', err.stack);
    next(err);
  }
});

module.exports = router;
