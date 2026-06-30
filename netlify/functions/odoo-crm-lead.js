// netlify/functions/odoo-crm-lead.js
// POST /api/odoo-crm-lead  -> crea un crm.lead (lead u oportunidad) en Odoo.
// Recibe el JSON que envía deploy/crm.html. Odoo queda como base de datos.
import { executeKw, checkToken, json } from "./lib/odoo.js";

// Odoo guarda la prioridad como selección de texto: 0=Baja,1=Normal,2=Alta,3=Muy alta
const PRIORIDAD = { "Normal": "1", "Media": "2", "Alta": "2", "Muy alta": "3" };

// Busca el id de un registro relacional por nombre; si no existe (y se pide), lo crea.
async function resolverId(model, nombre, crearSiFalta = false, extra = {}) {
  if (!nombre) return null;
  const found = await executeKw(model, "search_read",
    [[["name", "=", nombre]]], { fields: ["id"], limit: 1 });
  if (found && found.length) return found[0].id;
  if (!crearSiFalta) return null;
  return await executeKw(model, "create", [{ name: nombre, ...extra }]);
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
    // ----- Campos base de crm.lead (los seguros, sin riesgo de relacional inválido) -----
    const vals = {
      type: b.type === "opportunity" ? "opportunity" : "lead",
      name: b.name || b.partner_name || b.contact_name,
      contact_name: b.contact_name || "",
      partner_name: b.partner_name || "",
      email_from: b.email_from || "",
      phone: b.phone || "",
      description: b.description || "",
    };

    // Contacto existente en Odoo (vino del buscador): vincula por id.
    if (b.partner_id) vals.partner_id = Number(b.partner_id);

    // Solo para oportunidades: monto, cierre, prioridad.
    if (vals.type === "opportunity") {
      if (b.expected_revenue) vals.expected_revenue = Number(b.expected_revenue) || 0;
      if (b.date_deadline) vals.date_deadline = b.date_deadline; // formato YYYY-MM-DD
      if (b.priority && PRIORIDAD[b.priority]) vals.priority = PRIORIDAD[b.priority];

      // Etapa por nombre (stage_id). Si tu pipeline usa otros nombres, ajústalos en el front.
      const stageId = await resolverId("crm.stage", b.stage, false);
      if (stageId) vals.stage_id = stageId;

      // Etiquetas (tag_ids es many2many -> sintaxis [(6,0,[ids])]). Crea las que falten.
      if (Array.isArray(b.tags) && b.tags.length) {
        const tagIds = [];
        for (const t of b.tags) {
          const id = await resolverId("crm.tag", t, true);
          if (id) tagIds.push(id);
        }
        if (tagIds.length) vals.tag_ids = [[6, 0, tagIds]];
      }
    }

    // Origen / fuente (source_id de utm.source). Se crea si no existe.
    const sourceId = await resolverId("utm.source", b.source, true);
    if (sourceId) vals.source_id = sourceId;

    // NOTA sobre relacionales que requieren mapeo a IDs de Odoo:
    //  - team_id (equipo): mapea b.team a crm.team por nombre si tus equipos coinciden:
    //      const teamId = await resolverId("crm.team", b.team, false); if (teamId) vals.team_id = teamId;
    //  - user_id (vendedor): el front manda "emp:<hr.employee id>", pero user_id es un res.users.
    //      Para atribuir bien al vendedor, mapea el correo del usuario del portal a res.users.
    //      Mientras tanto, dejamos user_id por defecto (el usuario de la API) y guardamos
    //      el nombre del vendedor en la descripción para no perder el dato.
    if (b.user && b.team) {
      vals.description = `Vendedor: ${b.user} · Equipo: ${b.team}\n\n${vals.description}`;
    }

    // ----- Crear en Odoo -----
    const id = await executeKw("crm.lead", "create", [vals]);

    return json({ ok: true, id });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
