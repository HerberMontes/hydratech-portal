// netlify/functions/reporte-listar.js
// GET /api/reporte-listar?status=submitted,approved  -> { ok, reportes:[...] }
// Lista los reportes guardados (resumen) para el panel de administración.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT_NAME = "portal_reporte.json";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const want = (url.searchParams.get("status") || "submitted,approved")
      .split(",").map((s) => s.trim()).filter(Boolean);

    const atts = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["name", "=", ATT_NAME]]],
      { fields: ["res_id", "datas", "write_date"], order: "write_date desc", limit: 500 });

    const reportes = [];
    for (const a of atts) {
      let rep = null;
      try { rep = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {}
      if (!rep) continue;
      const st = rep.status || "draft";
      if (want.length && !want.includes(st)) continue;
      reportes.push({
        orderId: a.res_id, status: st,
        folio: rep.folio || "", cliente: rep.cliente || "",
        tipo: rep.tipo || (rep.notas && rep.notas.tipo) || "",
        fecha: rep.fecha || "", brand: rep.brand || "",
        tecnicos: rep.tecnicos || [],
        updatedAt: rep.updatedAt || a.write_date, submittedAt: rep.submittedAt || "",
      });
    }
    return json({ ok: true, count: reportes.length, reportes });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
