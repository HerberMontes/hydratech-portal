// netlify/functions/odoo-empleados.js
// GET /api/odoo-empleados  -> lista de empleados (técnicos) para seleccionar
import { executeKw, checkToken, json } from "./lib/odoo.js";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const rows = await executeKw(
      "hr.employee", "search_read", [[["active", "=", true]]],
      { fields: ["id", "name", "job_title"], order: "name", limit: 400 }
    );
    return json({ ok: true, empleados: rows.map((e) => ({ id: e.id, name: e.name, job: e.job_title || "" })) });
  } catch (e) {
    // Si no hay módulo de Empleados o falta permiso, el frontend usa captura manual.
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
