// netlify/functions/manguera-ficha.js
// GET /api/manguera-ficha?c=<partnerId>&m=<mangueraId>
// Devuelve la ficha completa de UNA manguera (la que se escanea con el QR):
// datos técnicos + cliente, área y equipo donde está instalada.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT = "portal_mangueras.json";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  const url = new URL(req.url);
  const partnerId = parseInt(url.searchParams.get("c") || 0, 10);
  const mangId = String(url.searchParams.get("m") || "").trim();
  if (!partnerId || !mangId) return json({ ok: false, error: "Faltan parámetros (c, m)." }, 400);

  try {
    const ex = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "res.partner"], ["res_id", "=", partnerId], ["name", "=", ATT]]],
      { fields: ["datas"], limit: 1 });
    if (!ex.length) return json({ ok: false, error: "Este cliente no tiene censo de mangueras." }, 404);

    let doc;
    try { doc = JSON.parse(Buffer.from(ex[0].datas || "", "base64").toString("utf8")); }
    catch { return json({ ok: false, error: "El censo del cliente está dañado." }, 500); }

    let found = null;
    for (const a of doc.areas || []) {
      for (const e of a.equipos || []) {
        const m = (e.mangueras || []).find((x) => x.id === mangId);
        if (m) { found = { manguera: m, area: a.nombre, equipo: e.nombre }; break; }
      }
      if (found) break;
    }
    if (!found) return json({ ok: false, error: `No encontré la manguera ${mangId} en este cliente.` }, 404);

    const partner = await executeKw("res.partner", "read", [[partnerId], ["name"]]);
    const cliente = partner && partner[0] ? partner[0].name : `Cliente ${partnerId}`;

    return json({ ok: true, cliente, clienteId: partnerId, ...found });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
