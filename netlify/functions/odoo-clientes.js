// netlify/functions/odoo-clientes.js
// GET /api/odoo-clientes  -> lista de clientes (res.partner) para el selector
// del configurador. Devuelve id + nombre.
import { executeKw, checkToken, json } from "./lib/odoo.js";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const fields = ["id", "name"];
    // Primero intenta solo clientes (customer_rank > 0).
    let rows = await executeKw(
      "res.partner", "search_read",
      [[["customer_rank", ">", 0]]],
      { fields, order: "name", limit: 1000 }
    );
    // Si no hay ninguno marcado como cliente, trae contactos tipo empresa/persona.
    if (!rows || rows.length === 0) {
      rows = await executeKw(
        "res.partner", "search_read",
        [[["type", "=", "contact"]]],
        { fields, order: "name", limit: 1000 }
      );
    }
    return json({ ok: true, clientes: rows.map((c) => ({ id: c.id, name: c.name })) });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
