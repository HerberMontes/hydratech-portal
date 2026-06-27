// netlify/functions/reporte-obtener.js
// GET /api/reporte-obtener?id=NN  -> { ok, report|null }
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT_NAME = "portal_reporte.json";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const id = parseInt(url.searchParams.get("id") || "0", 10);
    if (!id) return json({ ok: false, error: "Falta el id de la orden." }, 400);

    const found = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "=", ATT_NAME]]],
      { fields: ["datas"], limit: 1 });

    if (!found.length) return json({ ok: true, report: null });
    let report = null;
    try { report = JSON.parse(Buffer.from(found[0].datas || "", "base64").toString("utf8")); } catch (e) {}
    return json({ ok: true, report });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
