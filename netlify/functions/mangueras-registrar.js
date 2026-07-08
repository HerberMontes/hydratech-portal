// netlify/functions/mangueras-registrar.js
// POST /api/mangueras-registrar
// Body: { partnerId, areaId, equipoId, folio, mangueras: [{id,pres,len,A,B,fecha}] }
// La llama el COTIZADOR al crear una cotización en Odoo: anexa las mangueras
// al plan de mantenimiento del cliente (portal_mangueras.json en res.partner),
// dentro del área/equipo elegidos. Se hace del lado servidor (leer→anexar→
// escribir) para no pelear con la revisión del catálogo.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT = "portal_mangueras.json";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Usa POST." }, 405);
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "JSON inválido." }, 400); }

  const partnerId = parseInt(body.partnerId || 0, 10);
  const { areaId, equipoId, folio } = body;
  const mangueras = Array.isArray(body.mangueras) ? body.mangueras : [];
  if (!partnerId || !areaId || !equipoId) return json({ ok: false, error: "Faltan cliente, área o equipo." }, 400);
  if (!mangueras.length) return json({ ok: false, error: "No hay mangueras que registrar." }, 400);

  try {
    const ex = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "res.partner"], ["res_id", "=", partnerId], ["name", "=", ATT]]],
      { fields: ["id", "datas"], limit: 1 });
    if (!ex.length) return json({ ok: false, error: "El cliente no tiene catálogo de áreas/equipos." }, 404);

    let doc;
    try { doc = JSON.parse(Buffer.from(ex[0].datas || "", "base64").toString("utf8")); }
    catch { return json({ ok: false, error: "El catálogo del cliente está dañado." }, 500); }

    const area = (doc.areas || []).find((a) => a.id === areaId);
    const equipo = area && (area.equipos || []).find((e) => e.id === equipoId);
    if (!equipo) return json({ ok: false, error: "El área o el equipo ya no existen en el catálogo." }, 404);

    equipo.mangueras = equipo.mangueras || [];
    for (const m of mangueras) {
      equipo.mangueras.push({
        id: String(m.id), pres: +m.pres || 0, len: +m.len || 0,
        A: m.A || {}, B: m.B || {},
        folio: folio || "", fecha: m.fecha || new Date().toISOString().slice(0, 10),
        vidaMeses: 12, estado: "cotizada",
      });
    }
    doc.rev = (doc.rev || 0) + 1;
    doc.updated = new Date().toISOString();

    await executeKw("ir.attachment", "write", [[ex[0].id], {
      datas: Buffer.from(JSON.stringify(doc), "utf8").toString("base64"),
    }]);
    return json({ ok: true, registradas: mangueras.length, rev: doc.rev });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
