// netlify/functions/reporte-guardar.js
// POST /api/reporte-guardar  body: { id, status, report }
// Guarda el reporte como adjunto JSON (portal_reporte.json) en la orden de venta.
// status: "draft" (borrador) | "submitted" (enviado a aprobación) | "approved" | "cancelled"
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT_NAME = "portal_reporte.json";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const body = await req.json();
    const id = parseInt(body.id || body.orderId || 0, 10);
    if (!id) return json({ ok: false, error: "Falta el id de la orden." }, 400);

    const status = ["draft", "submitted", "approved", "cancelled"].includes(body.status) ? body.status : "draft";
    const report = Object.assign({}, body.report || {}, { status });
    const now = new Date().toISOString();
    report.updatedAt = now;
    if (status === "submitted" && !report.submittedAt) report.submittedAt = now;
    if (status === "approved") report.approvedAt = now;

    const datas = Buffer.from(JSON.stringify(report), "utf8").toString("base64");

    const existing = await executeKw("ir.attachment", "search",
      [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "=", ATT_NAME]]], { limit: 1 });

    if (existing.length) {
      await executeKw("ir.attachment", "write", [[existing[0]], { datas }]);
    } else {
      await executeKw("ir.attachment", "create", [{
        name: ATT_NAME, res_model: "sale.order", res_id: id,
        type: "binary", mimetype: "application/json", datas,
      }]);
    }
    return json({ ok: true, status });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
