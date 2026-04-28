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
    const { state } = req.body;
    if (isNaN(idBackpack) || state === undefined) {
      return res.status(400).json({ error: 'id y state son requeridos' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('_IdBackpack', sql.Int, idBackpack)
      .input('_State', sql.Int, state)
      .query('EXEC lm5k.spm_update_backpack @_IdBackpack, @_State');

    const row = result.recordset[0];
    if (row && row.result === 'non-affected') {
      return res.status(404).json({ error: 'Mochila no encontrada' });
    }

    // ── Mensajes masivos al aceptar mochila (state 2 = En Ruta) ─────────────
    if (state === 2) {
      try {
        const ordersResult = await pool.request()
          .input('IdBackpack', sql.Int, idBackpack)
          .query(`
            SELECT ov.folioOrdenCliente, ov.telefonoPrincipal, ov.cliente
            FROM lm5k.tb_contenido_backpacks cb
            INNER JOIN lm5k.OrdenesVenta ov ON ov.id = cb.IdOrdenVenta
            WHERE cb.IdBackPack = @IdBackpack AND cb.Deleted = 0
          `);

        const orders = ordersResult.recordset;
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
        console.error('Error en mensajes masivos:', msgErr.message);
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
 * PUT /api/backpacks/items/:id/validate
 * Valida un ítem por escaneo (spm_updateBackpackItemValidation)
 */
router.put('/items/:id/validate', async (req, res, next) => {
  try {
    const idBackpackItem = parseInt(req.params.id, 10);
    if (isNaN(idBackpackItem)) return res.status(400).json({ error: 'ID inválido' });

    const pool = await getPool();
    const result = await pool.request()
      .input('IdBackpackItem', sql.Int, idBackpackItem)
      .query('EXEC lm5k.spm_updateBackpackItemValidation @IdBackpackItem');

    const row = result.recordset[0];
    if (row && row.result === 'non-affected') {
      return res.status(404).json({ error: 'Ítem no encontrado' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
