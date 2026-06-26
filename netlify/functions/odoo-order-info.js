// netlify/functions/odoo-order-info.js
// GET /api/odoo-order-info?id=NN
// Datos para autollenar el reporte: cliente, fecha, planta(=dirección del cliente),
// tipo de servicio (= producto de servicio de la orden) y folio.
import { executeKw, checkToken, json } from "./lib/odoo.js";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const id = parseInt(url.searchParams.get("id") || "0", 10);
    if (!id) return json({ ok: false, error: "Falta el id de la orden." }, 400);

    const [o] = await executeKw("sale.order", "read", [[id]], { fields: ["name", "partner_id", "date_order"] });
    if (!o) return json({ ok: false, error: "Orden no encontrada." }, 404);
    const partnerId = Array.isArray(o.partner_id) ? o.partner_id[0] : null;

    let direccion = "";
    if (partnerId) {
      const [p] = await executeKw("res.partner", "read", [[partnerId]], { fields: ["contact_address", "street", "street2", "city", "state_id", "zip"] });
      if (p) {
        direccion = (p.contact_address || "").replace(/\s*\n\s*/g, ", ").replace(/(,\s*)+$/,"").replace(/^,\s*/,"").trim();
        if (!direccion) direccion = [p.street, p.street2, p.city, Array.isArray(p.state_id) ? p.state_id[1] : "", p.zip].filter(Boolean).join(", ");
      }
    }

    // Tipo de servicio = nombre del producto de servicio de la orden (primera línea de servicio)
    let tipo = "";
    const serv = await executeKw(
      "sale.order.line", "search_read", [[["order_id", "=", id], ["product_id.type", "=", "service"]]],
      { fields: ["name", "product_id"], order: "sequence", limit: 1 }
    ).catch(() => []);
    if (serv.length) tipo = Array.isArray(serv[0].product_id) ? serv[0].product_id[1] : (serv[0].name || "");

    return json({ ok: true, info: {
      folio: o.name,
      cliente: Array.isArray(o.partner_id) ? o.partner_id[1] : "",
      fecha: (o.date_order || "").slice(0, 10),
      direccion, tipo,
    }});
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
