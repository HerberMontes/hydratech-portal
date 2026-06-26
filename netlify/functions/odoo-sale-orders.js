// netlify/functions/odoo-sale-orders.js
// GET /api/odoo-sale-orders?q=texto&limit=30
// Busca órdenes de venta por número o cliente.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const STATE_ES = { draft: "Cotización", sent: "Cotización enviada", sale: "Orden de venta", done: "Bloqueada", cancel: "Cancelada" };

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "30", 10) || 30, 100);

    const domain = q ? ["|", ["name", "ilike", q], ["partner_id", "ilike", q]] : [];
    const orders = await executeKw(
      "sale.order", "search_read", [domain],
      { fields: ["id", "name", "partner_id", "date_order", "amount_total", "state", "user_id"], limit, order: "date_order desc" }
    );
    const rows = orders.map((o) => ({
      id: o.id, name: o.name,
      partner: Array.isArray(o.partner_id) ? o.partner_id[1] : "",
      date: o.date_order || "",
      total: o.amount_total || 0,
      state: o.state, stateLabel: STATE_ES[o.state] || o.state,
      seller: Array.isArray(o.user_id) ? o.user_id[1] : "",
    }));
    return json({ ok: true, count: rows.length, orders: rows });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
