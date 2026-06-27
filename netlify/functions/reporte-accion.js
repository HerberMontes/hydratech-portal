// netlify/functions/reporte-accion.js
// POST /api/reporte-accion  body: { id, action: "approve" | "cancel" }
// approve  -> marca el reporte como aprobado (queda archivado en la orden).
// cancel   -> ELIMINA el reporte de la orden; la orden vuelve a aparecer para rehacerse desde cero.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT_NAME = "portal_reporte.json";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const body = await req.json();
    const id = parseInt(body.id || body.orderId || 0, 10);
    const action = body.action;
    if (!id) return json({ ok: false, error: "Falta el id de la orden." }, 400);
    if (!["approve", "cancel"].includes(action)) return json({ ok: false, error: "Acción no válida." }, 400);

    const found = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "=", ATT_NAME]]],
      { fields: ["id", "datas"], limit: 1 });
    if (!found.length) return json({ ok: false, error: "No hay reporte guardado en esta orden." }, 404);

    if (action === "cancel") {
      // Borrar el adjunto: el reporte desaparece y la orden vuelve a la lista del técnico.
      await executeKw("ir.attachment", "unlink", [[found[0].id]]);
      return json({ ok: true, action, status: "cancelled" });
    }

    // approve: leer, cambiar estado a aprobado, guardar.
    let rep = {};
    try { rep = JSON.parse(Buffer.from(found[0].datas || "", "base64").toString("utf8")) || {}; } catch (e) {}
    rep.status = "approved";
    rep.approvedAt = new Date().toISOString();
    const datas = Buffer.from(JSON.stringify(rep), "utf8").toString("base64");
    await executeKw("ir.attachment", "write", [[found[0].id], { datas }]);
    return json({ ok: true, action, status: "approved" });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
