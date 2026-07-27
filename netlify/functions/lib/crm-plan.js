// netlify/functions/lib/crm-plan.js
// Convierte el PLAN DE ACCIÓN de un reporte aprobado en UNA oportunidad del
// CRM de Odoo, ligada al cliente de la orden y asignada a su vendedor, con una
// actividad (con fecha límite) por cada punto del plan.
// Se llama al VALIDAR el reporte (WhatsApp o portal). Idempotente: si el
// reporte ya tiene crmLeadId, no duplica.
import { executeKw, duenoPipeline, etapaPorNombre, tagOrigen, fuenteUTM, avisarOportunidadNueva } from "./odoo.js";

const DIAS_URGENCIA = (u) => /0-15/.test(u || "") ? 15 : /1-2/.test(u || "") ? 60 : /6/.test(u || "") ? 180 : 30;
const PRIO = { alta: "2", media: "1", baja: "0" };

export async function crearOportunidadDePlan(orderId, rep) {
  const plan = (rep && rep.content && rep.content.plan) || [];
  if (!plan.length) return null;              // sin plan, no hay nada que conectar
  if (rep.crmLeadId) return rep.crmLeadId;    // ya se creó antes

  // Datos de la orden: cliente y vendedor
  const ord = (await executeKw("sale.order", "read", [[orderId]],
    { fields: ["name", "partner_id", "user_id"] }).catch(() => []))[0] || {};
  const partnerId = Array.isArray(ord.partner_id) ? ord.partner_id[0] : null;
  const cliente = Array.isArray(ord.partner_id) ? ord.partner_id[1] : (rep.cliente || "");
  const vendedorId = Array.isArray(ord.user_id) ? ord.user_id[0] : null;

  const alta = plan.some((p) => p.prioridad === "alta");
  const ul = plan.map((p) =>
    `<li><b>${p.titulo || ""}</b>${p.descripcion ? ": " + p.descripcion : ""} <i>(${p.prioridad || "media"} · ${p.urgencia || "sin plazo"})</i></li>`).join("");
  const c = rep.content || {};
  const desc =
    `<p><b>Plan de acción</b> del reporte de servicio <b>${rep.folio || ord.name || ""}</b> (${rep.fecha || ""}) — técnicos: ${(rep.tecnicos || []).join(", ") || "n/d"}.</p>` +
    `<ul>${ul}</ul>` +
    (c.cta_titulo ? `<p><b>Siguiente paso sugerido:</b> ${c.cta_titulo}${c.cta_texto ? " — " + c.cta_texto : ""}</p>` : "") +
    `<p><i>El reporte completo está archivado en la orden ${rep.folio || ord.name || orderId}.</i></p>`;

  const lead = {
    name: `Plan de acción ${rep.folio || ord.name || orderId} — ${cliente}`,
    type: "opportunity", description: desc,
    priority: alta ? "2" : "1",
  };
  if (partnerId) lead.partner_id = partnerId;

  /* DUEÑO: hoy una sola persona mueve el pipeline. Si CRM_OWNER_EMAIL está
     configurada, la oportunidad se le asigna a ella; si no, al vendedor de la
     orden, como antes. */
  const dueno = await duenoPipeline();
  const asignadoId = dueno ? dueno.id : vendedorId;
  if (asignadoId) lead.user_id = asignadoId;

  /* ETAPA: estas SIEMPRE nacen en "Nuevo" del pipeline comercial. Viene de una
     orden de venta ya confirmada, o sea un cliente activo con trabajo hecho:
     no hay nada que prospectar. Sin esta línea Odoo le ponía su etapa por
     defecto ("Por contactar") y la tarjeta caía en "Fuera de etapa". */
  const etapa = await etapaPorNombre(["Nuevo", "New", "Nueva"]);
  if (etapa) lead.stage_id = etapa;

  /* Trazabilidad: de dónde salió esta oportunidad */
  const tagOrig = await tagOrigen(((rep.tecnicos || [])[0]) || "Reporte de servicio");
  if (tagOrig) lead.tag_ids = [[4, tagOrig]];
  const fuente = await fuenteUTM("Plan de acción de reporte");
  if (fuente) lead.source_id = fuente;

  const leadId = await executeKw("crm.lead", "create", [lead]);

  await avisarOportunidadNueva({
    leadId,
    titulo: lead.name,
    cliente,
    monto: 0,
    origen: ((rep.tecnicos || [])[0]) || "",
    canal: "Plan de acción de reporte",
    detalle: plan.map((p) => "• " + (p.titulo || "")).join("\n"),
  });

  // Una actividad por punto del plan, con deadline según la urgencia
  try {
    const modelIds = await executeKw("ir.model", "search", [[["model", "=", "crm.lead"]]], { limit: 1 });
    const tipoIds = await executeKw("mail.activity.type", "search",
      [["|", ["name", "ilike", "to-do"], ["name", "ilike", "por hacer"]]], { limit: 1 }).catch(() => []);
    for (const p of plan.slice(0, 12)) {
      const deadline = new Date(Date.now() + DIAS_URGENCIA(p.urgencia) * 864e5).toISOString().slice(0, 10);
      await executeKw("mail.activity", "create", [{
        res_model_id: modelIds[0], res_id: leadId,
        ...(tipoIds.length ? { activity_type_id: tipoIds[0] } : {}),
        summary: (`[${p.prioridad || "media"}] ` + (p.titulo || "")).slice(0, 120),
        note: p.descripcion || "",
        date_deadline: deadline,
        ...(asignadoId ? { user_id: asignadoId } : {}),
      }]).catch(() => {});
    }
  } catch (e) {}

  // Constancia en la orden
  await executeKw("sale.order", "message_post", [[orderId]], {
    body: `Plan de acción del reporte convertido en oportunidad del CRM (lead #${leadId}).`,
  }).catch(() => {});

  return leadId;
}
