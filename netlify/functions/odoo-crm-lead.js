// netlify/functions/odoo-crm-lead.js
// POST /api/odoo-crm-lead  -> crea un crm.lead (lead u oportunidad) en Odoo.
// Recibe el JSON que envía deploy/crm.html. Odoo queda como base de datos.
import { executeKw, checkToken, json } from "./lib/odoo.js";

// Odoo guarda la prioridad como selección de texto: 0=Baja,1=Normal,2=Alta,3=Muy alta
const PRIORIDAD = { "Normal": "1", "Media": "2", "Alta": "2", "Muy alta": "3" };

// Busca el id de un registro relacional por nombre; si no existe (y se pide), lo crea.
// NUNCA lanza: si algo falla, devuelve null para no bloquear la creación del lead.
async function resolverIdSeguro(model, nombre, crearSiFalta = false, extra = {}) {
  if (!nombre) return null;
  try {
    const found = await executeKw(model, "search_read",
      [[["name", "=", nombre]]], { fields: ["id"], limit: 1 });
    if (found && found.length) return found[0].id;
    if (!crearSiFalta) return null;
    return await executeKw(model, "create", [{ name: nombre, ...extra }]);
  } catch (e) {
    return null; // permisos, modelo ausente, etc. -> se omite ese campo
  }
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  if (req.method !== "POST") return json({ ok: false, error: "Usa POST." }, 405);

  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: "JSON inválido." }, 400); }

  if (!b.contact_name && !b.partner_name) {
    return json({ ok: false, error: "Falta el nombre del contacto o la empresa." }, 400);
  }

  try {
    // ----- Campos base (sin riesgo: siempre se crean) -----
    const vals = {
      type: b.type === "opportunity" ? "opportunity" : "lead",
      name: b.name || b.partner_name || b.contact_name,
      contact_name: b.contact_name || "",
      partner_name: b.partner_name || "",
      email_from: b.email_from || "",
      phone: b.phone || "",
      description: b.description || "",
    };
    if (b.partner_id) vals.partner_id = Number(b.partner_id);

    if (vals.type === "opportunity") {
      if (b.expected_revenue) vals.expected_revenue = Number(b.expected_revenue) || 0;
      if (b.date_deadline) vals.date_deadline = b.date_deadline; // YYYY-MM-DD
      if (b.priority && PRIORIDAD[b.priority]) vals.priority = PRIORIDAD[b.priority];

      // ----- Relacionales: mejor esfuerzo, nunca bloquean -----
      const stageId = await resolverIdSeguro("crm.stage", b.stage, false);
      if (stageId) vals.stage_id = stageId;

      if (Array.isArray(b.tags) && b.tags.length) {
        const tagIds = [];
        for (const t of b.tags) {
          const id = await resolverIdSeguro("crm.tag", t, true);
          if (id) tagIds.push(id);
        }
        if (tagIds.length) vals.tag_ids = [[6, 0, tagIds]];
      }
    }

    const sourceId = await resolverIdSeguro("utm.source", b.source, true);
    if (sourceId) vals.source_id = sourceId;

    // Vendedor/equipo: por ahora se guardan en la descripción (ver nota más abajo).
    if (b.user || b.team) {
      const extra = `Vendedor: ${b.user || "-"} · Equipo: ${b.team || "-"}`;
      vals.description = vals.description ? `${extra}\n\n${vals.description}` : extra;
    }

    // ----- Crear en Odoo (esto sí debe funcionar) -----
    const id = await executeKw("crm.lead", "create", [vals]);
    return json({ ok: true, id });
  } catch (e) {
    // Devolvemos el mensaje real de Odoo para depurar fácil.
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
