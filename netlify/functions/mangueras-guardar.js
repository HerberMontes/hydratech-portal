// netlify/functions/mangueras-guardar.js
// POST /api/mangueras-guardar  body: { partnerId, rev, doc }
// Guarda el censo completo del cliente como adjunto JSON (portal_mangueras.json)
// en res.partner. Usa "rev" para evitar que dos técnicos se pisen los cambios:
// si el rev del navegador no coincide con el guardado, responde 409 y el
// portal recarga antes de reintentar.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT = "portal_mangueras.json";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Usa POST." }, 405);
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "JSON inválido." }, 400); }

  const partnerId = parseInt(body.partnerId || 0, 10);
  const doc = body.doc;
  if (!partnerId) return json({ ok: false, error: "Falta el cliente (partnerId)." }, 400);
  if (!doc || !Array.isArray(doc.areas)) return json({ ok: false, error: "Documento de censo inválido." }, 400);

  try {
    const ex = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "res.partner"], ["res_id", "=", partnerId], ["name", "=", ATT]]],
      { fields: ["id", "datas"], limit: 1 });

    let currentRev = 0;
    if (ex.length) {
      try { currentRev = (JSON.parse(Buffer.from(ex[0].datas || "", "base64").toString("utf8")).rev) || 0; }
      catch { currentRev = 0; }
    }

    const sentRev = parseInt(body.rev || 0, 10);
    if (ex.length && sentRev !== currentRev) {
      return json({ ok: false, conflict: true, error: "Otra persona guardó cambios antes que tú. Recarga el censo y vuelve a intentar." }, 409);
    }

    const nextDoc = { ...doc, rev: currentRev + 1, updated: new Date().toISOString() };
    const datas = Buffer.from(JSON.stringify(nextDoc), "utf8").toString("base64");

    if (ex.length) {
      await executeKw("ir.attachment", "write", [[ex[0].id], { datas }]);
    } else {
      await executeKw("ir.attachment", "create", [{
        name: ATT, res_model: "res.partner", res_id: partnerId,
        type: "binary", mimetype: "application/json", datas,
      }]);
    }
    return json({ ok: true, rev: nextDoc.rev });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
