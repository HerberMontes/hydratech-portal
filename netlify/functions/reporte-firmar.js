// netlify/functions/reporte-firmar.js
// GET  /api/reporte-firmar?id=NN&t=TOKEN   -> regresa el reporte para mostrarlo en firma.html
// POST /api/reporte-firmar                 -> body { id, t, firma(dataURL), firmante }
//      guarda la firma, marca APROBADO y archiva en Odoo (orden + Field Service),
//      y avisa por WhatsApp al admin y al técnico.
import crypto from "node:crypto";
import { executeKw, json } from "./lib/odoo.js";
import { enviarTexto } from "./lib/whatsapp.js";

const ATT_NAME = "portal_reporte.json";
const SECRET = process.env.FIRMA_SECRET || process.env.PORTAL_TOKEN || "hydratech";
const ADMIN = (process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "");
const tokenDe = (id) => crypto.createHmac("sha256", SECRET).update(String(id)).digest("hex").slice(0, 24);

async function attDe(id) {
  const found = await executeKw("ir.attachment", "search_read",
    [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "=", ATT_NAME]]],
    { fields: ["id", "datas"], limit: 1 });
  if (!found.length) return null;
  let rep = null;
  try { rep = JSON.parse(Buffer.from(found[0].datas || "", "base64").toString("utf8")); } catch (e) {}
  return { attId: found[0].id, rep };
}

export default async (req) => {
  try {
    if (req.method === "GET") {
      const u = new URL(req.url);
      const id = parseInt(u.searchParams.get("id") || 0, 10);
      const t = u.searchParams.get("t") || "";
      if (!id || t !== tokenDe(id)) return json({ ok: false, error: "Link no válido." }, 403);
      const r = await attDe(id);
      if (!r || !r.rep) return json({ ok: false, error: "No hay reporte en esta orden." }, 404);
      if (r.rep.status === "approved") return json({ ok: true, yaFirmado: true, report: r.rep });
      if (r.rep.status !== "validated") return json({ ok: false, error: "El reporte aún no está validado para firma." }, 409);
      return json({ ok: true, report: r.rep });
    }

    if (req.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);
    const body = await req.json();
    const id = parseInt(body.id || 0, 10);
    if (!id || (body.t || "") !== tokenDe(id)) return json({ ok: false, error: "Link no válido." }, 403);
    if (!/^data:image\//.test(body.firma || "")) return json({ ok: false, error: "Falta la firma." }, 400);

    const r = await attDe(id);
    if (!r || !r.rep) return json({ ok: false, error: "No hay reporte en esta orden." }, 404);
    if (r.rep.status === "approved") return json({ ok: true, yaFirmado: true });

    const rep = r.rep;
    rep.firma = { imagen: body.firma, firmante: (body.firmante || "").slice(0, 120), fecha: new Date().toISOString() };
    rep.status = "approved"; rep.approvedAt = rep.firma.fecha;
    const datas = Buffer.from(JSON.stringify(rep), "utf8").toString("base64");
    await executeKw("ir.attachment", "write", [[r.attId], { datas }]);

    // Constancia en la orden
    await executeKw("sale.order", "message_post", [[id]], {
      body: `Reporte de servicio FIRMADO por ${rep.firma.firmante || "el cliente"} vía portal HydraTech (${rep.firma.fecha.slice(0, 16).replace("T", " ")}). Origen: ${rep.origen || "portal"}.`,
    }).catch(() => {});

    // Puente a Field Service: archivar copia y mover la tarea a "Hecho" (igual que reporte-accion.js)
    try {
      const tareas = await executeKw("project.task", "search_read", [[["sale_order_id", "=", id]]],
        { fields: ["id", "name", "project_id"], limit: 1 });
      if (tareas && tareas.length) {
        const t = tareas[0];
        const attId = await executeKw("ir.attachment", "create", [{
          name: "portal_reporte_aprobado.json", res_model: "project.task", res_id: t.id,
          type: "binary", mimetype: "application/json", datas,
        }]).catch(() => 0);
        await executeKw("project.task", "message_post", [[t.id]], {
          body: "Reporte de servicio FIRMADO y APROBADO desde WhatsApp/portal.",
          ...(attId ? { attachment_ids: [attId] } : {}),
        }).catch(() => {});
        const pid = Array.isArray(t.project_id) ? t.project_id[0] : t.project_id;
        const etapas = await executeKw("project.task.type", "search_read",
          [[["project_ids", "in", [pid]]]], { fields: ["id", "name", "fold"], limit: 50 }).catch(() => []);
        const hecha = (etapas || []).find((e) => /hecho|done|terminad|finaliz|complet/i.test(e.name || "")) || (etapas || []).find((e) => e.fold);
        if (hecha) await executeKw("project.task", "write", [[t.id], { stage_id: hecha.id }]).catch(() => {});
      }
    } catch (e) {}

    // Avisos por WhatsApp
    const aviso = `✍️ *${rep.folio || id}* firmado por ${rep.firma.firmante || "el cliente"} y archivado en Odoo. ✅`;
    if (ADMIN) enviarTexto(ADMIN, aviso).catch(() => {});
    if (rep.waTecnico) enviarTexto(rep.waTecnico, aviso + "\n¡Buen trabajo! Escribe *menu* para otro reporte.").catch(() => {});

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
