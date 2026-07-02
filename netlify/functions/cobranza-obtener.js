// netlify/functions/cobranza-obtener.js
// GET /api/cobranza-obtener?id=NN
// Lee los datos de cobranza de UNA orden y detecta automáticamente:
//   - reporteAprobado: ¿tiene el reporte adjunto con estado "approved"?  -> dispara "Entregado"
//   - acuseAdjunto:    ¿tiene el acuse adjunto?                          -> arranca reloj de pago
// Además devuelve SOLPED, OC, fecha de acuse, pago, términos de pago y referencia del cliente.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT = "portal_cobranza.json";
const REP = "portal_reporte.json";
const ACUSE_PREFIX = "portal_acuse";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const id = parseInt(url.searchParams.get("id") || "0", 10);
    if (!id) return json({ ok: false, error: "Falta el id de la orden." }, 400);

    const [o] = await executeKw("sale.order", "read", [[id]],
      { fields: ["name", "partner_id", "date_order", "amount_total", "state", "payment_term_id", "client_order_ref"] });
    if (!o) return json({ ok: false, error: "Orden no encontrada." }, 404);

    // Datos de cobranza guardados por el portal
    let cob = {};
    const c = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "=", ATT]]],
      { fields: ["datas"], limit: 1 });
    if (c.length) { try { cob = JSON.parse(Buffer.from(c[0].datas || "", "base64").toString("utf8")); } catch (e) {} }

    // ¿Reporte APROBADO? (evidencia de entrega válida)
    let reporteAprobado = false, reporteEstado = "";
    const r = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "=", REP]]],
      { fields: ["datas"], limit: 1 });
    if (r.length) { try { const rep = JSON.parse(Buffer.from(r[0].datas || "", "base64").toString("utf8")); reporteEstado = rep.status || "draft"; reporteAprobado = reporteEstado === "approved"; } catch (e) {} }

    // ¿Acuse adjunto?
    const ac = await executeKw("ir.attachment", "search",
      [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "like", ACUSE_PREFIX + "%"]]], { limit: 1 });
    const acuseAdjunto = ac.length > 0;

    return json({
      ok: true,
      orden: {
        id,
        folio: o.name,
        cliente: Array.isArray(o.partner_id) ? o.partner_id[1] : "",
        fecha: (o.date_order || "").slice(0, 10),
        monto: o.amount_total || 0,
        estadoOdoo: o.state || "",
        terminosPago: Array.isArray(o.payment_term_id) ? o.payment_term_id[1] : "",
        terminosPagoId: Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : false,
        refCliente: o.client_order_ref || "",
        // datos de cobranza
        solped: cob.solped || "",
        oc: cob.oc || "",
        acuseFecha: cob.acuseFecha || "",
        pago: cob.pago || null,
        // señales derivadas
        reporteAprobado, reporteEstado, acuseAdjunto,
      },
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
