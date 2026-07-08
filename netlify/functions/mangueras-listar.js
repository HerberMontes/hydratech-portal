// netlify/functions/mangueras-listar.js
// GET /api/mangueras-listar?partnerId=123   -> { ok, doc }  (censo completo del cliente)
// GET /api/mangueras-listar                 -> { ok, clientes:[{id,nombre,areas,equipos,mangueras}] }
// El censo vive como adjunto JSON (portal_mangueras.json) en el cliente (res.partner),
// mismo patrón que cobranza/reportes.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT = "portal_mangueras.json";
const EMPTY = () => ({ rev: 0, areas: [] });

function parseDoc(datas) {
  try { return JSON.parse(Buffer.from(datas || "", "base64").toString("utf8")); }
  catch { return EMPTY(); }
}

function countDoc(doc) {
  let equipos = 0, mangueras = 0;
  for (const a of doc.areas || []) {
    equipos += (a.equipos || []).length;
    for (const e of a.equipos || []) mangueras += (e.mangueras || []).length;
  }
  return { areas: (doc.areas || []).length, equipos, mangueras };
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  const url = new URL(req.url);
  const partnerId = parseInt(url.searchParams.get("partnerId") || 0, 10);

  try {
    if (partnerId) {
      const ex = await executeKw("ir.attachment", "search_read",
        [[["res_model", "=", "res.partner"], ["res_id", "=", partnerId], ["name", "=", ATT]]],
        { fields: ["datas"], limit: 1 });
      const doc = ex.length ? parseDoc(ex[0].datas) : EMPTY();
      return json({ ok: true, doc });
    }

    // Resumen global: qué clientes tienen censo y cuántas mangueras.
    const atts = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "res.partner"], ["name", "=", ATT]]],
      { fields: ["res_id", "datas"], limit: 500 });
    if (!atts.length) return json({ ok: true, clientes: [] });

    const ids = atts.map((a) => a.res_id);
    const partners = await executeKw("res.partner", "read", [ids, ["name"]]);
    const nameById = Object.fromEntries(partners.map((p) => [p.id, p.name]));

    const clientes = atts.map((a) => {
      const c = countDoc(parseDoc(a.datas));
      return { id: a.res_id, nombre: nameById[a.res_id] || `Cliente ${a.res_id}`, ...c };
    }).sort((x, y) => y.mangueras - x.mangueras);

    return json({ ok: true, clientes });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
