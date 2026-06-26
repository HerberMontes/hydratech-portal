// netlify/functions/odoo-order-activity.js
// GET  /api/odoo-order-activity?id=NN   -> detalle de la orden + líneas + actividades + bitácora
// POST /api/odoo-order-activity         -> { order_id, text }  registra un reporte en el chatter
import { executeKw, checkToken, json } from "./lib/odoo.js";

const STATE_ES = { draft: "Cotización", sent: "Cotización enviada", sale: "Orden de venta", done: "Bloqueada", cancel: "Cancelada" };

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);

  // ---- POST: registrar reporte de actividad en la orden ----
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const orderId = parseInt(body.order_id, 10);
      const text = (body.text || "").toString().trim();
      if (!orderId || !text) return json({ ok: false, error: "Falta order_id o texto." }, 400);
      const html = "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>";
      const msgId = await executeKw(
        "sale.order", "message_post", [[orderId]],
        { body: html, message_type: "comment", subtype_xmlid: "mail.mt_note" }
      );
      return json({ ok: true, message_id: msgId });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  // ---- GET: detalle + historial ----
  try {
    const url = new URL(req.url);
    const id = parseInt(url.searchParams.get("id") || "0", 10);
    if (!id) return json({ ok: false, error: "Falta el id de la orden." }, 400);

    const [order] = await executeKw(
      "sale.order", "read", [[id]],
      { fields: ["name", "partner_id", "date_order", "amount_untaxed", "amount_total", "state", "user_id"] }
    );
    if (!order) return json({ ok: false, error: "Orden no encontrada." }, 404);

    const lines = await executeKw(
      "sale.order.line", "search_read", [[["order_id", "=", id]]],
      { fields: ["product_id", "name", "product_uom_qty", "price_unit", "price_subtotal"], order: "sequence" }
    );

    const activities = await executeKw(
      "mail.activity", "search_read", [[["res_model", "=", "sale.order"], ["res_id", "=", id]]],
      { fields: ["activity_type_id", "summary", "date_deadline", "user_id"], order: "date_deadline" }
    ).catch(() => []);

    const messages = await executeKw(
      "mail.message", "search_read",
      [[["model", "=", "sale.order"], ["res_id", "=", id], ["message_type", "in", ["comment", "notification"]]]],
      { fields: ["date", "author_id", "body"], order: "date desc", limit: 40 }
    ).catch(() => []);

    return json({
      ok: true,
      order: {
        id, name: order.name,
        partner: Array.isArray(order.partner_id) ? order.partner_id[1] : "",
        date: order.date_order || "",
        untaxed: order.amount_untaxed || 0,
        total: order.amount_total || 0,
        state: order.state, stateLabel: STATE_ES[order.state] || order.state,
        seller: Array.isArray(order.user_id) ? order.user_id[1] : "",
      },
      lines: lines.map((l) => ({
        product: Array.isArray(l.product_id) ? l.product_id[1] : "",
        name: l.name, qty: l.product_uom_qty, price: l.price_unit, subtotal: l.price_subtotal,
      })),
      activities: activities.map((a) => ({
        type: Array.isArray(a.activity_type_id) ? a.activity_type_id[1] : "",
        summary: a.summary || "", deadline: a.date_deadline || "",
        user: Array.isArray(a.user_id) ? a.user_id[1] : "",
      })),
      log: messages.map((m) => ({
        date: m.date || "",
        author: Array.isArray(m.author_id) ? m.author_id[1] : "Sistema",
        text: stripHtml(m.body),
      })).filter((m) => m.text),
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
