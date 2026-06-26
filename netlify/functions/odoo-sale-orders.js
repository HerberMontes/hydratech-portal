// netlify/functions/odoo-sale-orders.js
// GET /api/odoo-sale-orders?q=texto&limit=40
// Solo trae órdenes que:
//   1) tengan AL MENOS una línea de producto tipo "Servicio"  (order_line.product_id.type = 'service')
//   2) sean de la fecha de corte en adelante  (REPORTES_DESDE, formato YYYY-MM-DD)
//   3) no estén canceladas
import { executeKw, checkToken, json } from "./lib/odoo.js";

const DESDE = process.env.REPORTES_DESDE || ""; // ej. "2026-06-26"
const SERVICE_FIELD = process.env.SERVICE_TYPE_FIELD || "order_line.product_id.type";

const STATE_ES = { draft: "Cotización", sent: "Cotización enviada", sale: "Orden de venta", done: "Bloqueada", cancel: "Cancelada" };

// Combina varios subdominios con AND explícito (notación prefija de Odoo).
function AND(subs) {
  subs = subs.filter((s) => s && s.length);
  if (subs.length === 0) return [];
  let d = [];
  for (let i = 0; i < subs.length - 1; i++) d.push("&");
  for (const s of subs) d = d.concat(s);
  return d;
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "40", 10) || 40, 100);

    const subs = [];
    if (DESDE) subs.push([["date_order", ">=", DESDE + " 00:00:00"]]);
    subs.push([[SERVICE_FIELD, "=", "service"]]);
    subs.push([["state", "!=", "cancel"]]);
    if (q) subs.push(["|", ["name", "ilike", q], ["partner_id", "ilike", q]]);
    const domain = AND(subs);

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
    return json({ ok: true, count: rows.length, desde: DESDE || null, orders: rows });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
