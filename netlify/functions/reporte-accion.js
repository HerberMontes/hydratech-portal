// netlify/functions/reporte-accion.js
// POST /api/reporte-accion  body: { id, action: "approve" | "cancel" }
// approve  -> marca el reporte como aprobado (queda archivado en la orden).
// cancel   -> ELIMINA el reporte de la orden; la orden vuelve a aparecer para rehacerse desde cero.
import { executeKw, checkToken, json } from "./lib/odoo.js";
import { crearOportunidadDePlan } from "./lib/crm-plan.js";

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
    /* PLAN -> CRM: el plan de acción se convierte en UNA oportunidad ligada al
       cliente y asignada al vendedor de la orden, con una actividad (y fecha
       límite según urgencia) por cada punto. Idempotente vía rep.crmLeadId. */
    let crmLeadId = null;
    try { crmLeadId = await crearOportunidadDePlan(id, rep); if (crmLeadId) rep.crmLeadId = crmLeadId; } catch (e) {}
    const datas = Buffer.from(JSON.stringify(rep), "utf8").toString("base64");
    await executeKw("ir.attachment", "write", [[found[0].id], { datas }]);

    /* ============ PUENTE A FIELD SERVICE (misma telaraña de Odoo) ============
       Si la orden tiene tarea de servicio ligada (Field Service / Proyecto):
       1) el reporte aprobado se archiva TAMBIÉN en la tarea,
       2) se deja constancia en su historial,
       3) la tarea se mueve a su etapa "Hecho".
       Todo tolerante: si no hay tarea o el módulo no está, la aprobación
       funciona exactamente igual que siempre. */
    const fieldService = { tarea: null, archivado: false, marcadaHecha: false };
    try {
      const tareas = await executeKw("project.task", "search_read",
        [[["sale_order_id", "=", id]]],
        { fields: ["id", "name", "project_id", "stage_id"], limit: 1 });
      if (tareas && tareas.length) {
        const t = tareas[0];
        fieldService.tarea = t.name;
        // 1) copia del reporte aprobado archivada en la tarea
        const attId = await executeKw("ir.attachment", "create", [{
          name: "portal_reporte_aprobado.json",
          res_model: "project.task", res_id: t.id,
          type: "binary", mimetype: "application/json", datas,
        }]).catch(() => 0);
        fieldService.archivado = !!attId;
        // 2) constancia en el historial de la tarea
        await executeKw("project.task", "message_post", [[t.id]], {
          body: "Reporte de servicio APROBADO en el portal HydraTech (" +
            new Date().toISOString().slice(0, 10) + "). El reporte quedó archivado en la orden y en esta tarea.",
          ...(attId ? { attachment_ids: [attId] } : {}),
        }).catch(() => {});
        // 3) mover la tarea a su etapa "Hecho" (la etapa cerrada del proyecto)
        try {
          const pid = Array.isArray(t.project_id) ? t.project_id[0] : t.project_id;
          const etapas = await executeKw("project.task.type", "search_read",
            [[["project_ids", "in", [pid]]]], { fields: ["id", "name", "fold"], limit: 50 });
          const hecha = (etapas || []).find((e) => /hecho|done|terminad|finaliz|complet/i.test(e.name || ""))
            || (etapas || []).find((e) => e.fold);
          if (hecha) {
            await executeKw("project.task", "write", [[t.id], { stage_id: hecha.id }]);
            fieldService.marcadaHecha = true;
          }
        } catch (e) {}
      }
    } catch (e) { /* Field Service no instalado o sin permisos: la aprobación no se afecta */ }

    return json({ ok: true, action, status: "approved", fieldService, crmLeadId });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
