// netlify/functions/cobranza-guardar.js
// POST /api/cobranza-guardar  body: { id, solped?, oc?, acuse?{name,datas,mimetype}, acuseFecha?, pago?{fecha,ref,complemento}, complemento? }
// Guarda los datos de cobranza como adjunto JSON (portal_cobranza.json) en la orden de venta,
// y el acuse (si viene) como adjunto binario (portal_acuse.<ext>). Mismo patrón que el reporte.
// El estado del flujo se DERIVA de estos datos; no se elige a mano.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT = "portal_cobranza.json";
const ACUSE_PREFIX = "portal_acuse";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const body = await req.json();
    const id = parseInt(body.id || body.orderId || 0, 10);
    if (!id) return json({ ok: false, error: "Falta el id de la orden." }, 400);

    // 1) Leer el registro actual (si existe) para no borrar lo previo.
    let data = {};
    const ex = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "=", ATT]]],
      { fields: ["id", "datas"], limit: 1 });
    if (ex.length) { try { data = JSON.parse(Buffer.from(ex[0].datas || "", "base64").toString("utf8")); } catch (e) {} }

    // 2) Aplicar solo los campos que llegan.
    if (body.solped !== undefined) data.solped = String(body.solped || "").trim();
    if (body.oc !== undefined) data.oc = String(body.oc || "").trim();
    if (body.pago !== undefined) data.pago = body.pago; // {fecha, ref, complemento} o null
    if (body.complemento !== undefined) { data.pago = data.pago || {}; data.pago.complemento = !!body.complemento; }
    if (body.acuseFecha !== undefined) data.acuseFecha = body.acuseFecha;

    // 3) Acuse (archivo) opcional: reemplaza el anterior y fija la fecha que arranca el reloj de pago.
    if (body.acuse && body.acuse.datas) {
      const ext = ((body.acuse.name || "").split(".").pop() || "pdf").toLowerCase();
      const acuseName = ACUSE_PREFIX + "." + ext;
      const prev = await executeKw("ir.attachment", "search",
        [[["res_model", "=", "sale.order"], ["res_id", "=", id], ["name", "like", ACUSE_PREFIX + "%"]]], {});
      if (prev.length) await executeKw("ir.attachment", "unlink", [prev]).catch(() => {});
      await executeKw("ir.attachment", "create", [{
        name: acuseName, res_model: "sale.order", res_id: id, type: "binary",
        mimetype: body.acuse.mimetype || "application/pdf", datas: body.acuse.datas,
      }]);
      // Si no mandaron fecha explícita, el acuse se toma como recibido hoy.
      if (body.acuseFecha === undefined) data.acuseFecha = new Date().toISOString().slice(0, 10);
    }

    data.updatedAt = new Date().toISOString();

    // 4) Guardar el JSON.
    const datas = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
    if (ex.length) await executeKw("ir.attachment", "write", [[ex[0].id], { datas }]);
    else await executeKw("ir.attachment", "create", [{
      name: ATT, res_model: "sale.order", res_id: id, type: "binary", mimetype: "application/json", datas,
    }]);

    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
