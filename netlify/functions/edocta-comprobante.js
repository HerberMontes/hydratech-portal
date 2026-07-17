// netlify/functions/edocta-comprobante.js
// Recibe el comprobante de pago que el cliente sube desde "Mi estado de cuenta".
// El archivo se adjunta a las órdenes seleccionadas, queda constancia en el
// chatter, se marca "en conciliación" y se te avisa por WhatsApp.
import { executeKw, json } from "./lib/odoo.js";
import { validarToken } from "./edocta.js";
import { enviarTexto } from "./lib/whatsapp.js";

const COB = "portal_cobranza.json";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);
  try {
    const form = await req.formData();
    const pid = validarToken(form.get("token"));
    if (!pid) return json({ ok: false, error: "Link no válido." }, 401);

    const referencia = String(form.get("referencia") || "").slice(0, 80);
    const fechaPago = String(form.get("fechaPago") || "").slice(0, 10);
    let folios = [];
    try { folios = JSON.parse(form.get("facturas") || "[]"); } catch (e) {}
    folios = (Array.isArray(folios) ? folios : []).map(String).slice(0, 20);
    const archivo = form.get("archivo");
    if (!archivo || typeof archivo.arrayBuffer !== "function") return json({ ok: false, error: "Falta el archivo del comprobante." }, 400);
    if (archivo.size > 8 * 1024 * 1024) return json({ ok: false, error: "El archivo excede 8 MB." }, 400);
    const b64 = Buffer.from(await archivo.arrayBuffer()).toString("base64");
    const mime = archivo.type || "application/pdf";
    const hoy = new Date().toISOString().slice(0, 10);

    // Órdenes del cliente que correspondan a los folios elegidos (o todas las suyas activas)
    const ordenes = await executeKw("sale.order", "search_read",
      [[["partner_id", "child_of", pid], ["state", "in", ["sale", "done"]], ...(folios.length ? [["name", "in", folios]] : [])]],
      { fields: ["id", "name", "partner_id"], limit: 30 });
    if (!ordenes.length) return json({ ok: false, error: "No se encontraron las órdenes indicadas." }, 404);

    const nombreCliente = Array.isArray(ordenes[0].partner_id) ? ordenes[0].partner_id[1] : "Cliente";
    for (const o of ordenes) {
      await executeKw("ir.attachment", "create", [{
        name: `comprobante-pago-${hoy}-${(referencia || "sin-ref").replace(/[^A-Za-z0-9._-]/g, "_")}.${mime.includes("pdf") ? "pdf" : "jpg"}`,
        res_model: "sale.order", res_id: o.id, type: "binary", mimetype: mime, datas: b64,
      }]);
      // Marcar "en conciliación" en el expediente de cobranza
      const found = await executeKw("ir.attachment", "search_read",
        [[["res_model", "=", "sale.order"], ["res_id", "=", o.id], ["name", "=", COB]]],
        { fields: ["id", "datas"], limit: 1 });
      let data = {}; let attId = null;
      if (found.length) { attId = found[0].id; try { data = JSON.parse(Buffer.from(found[0].datas || "", "base64").toString("utf8")) || {}; } catch (e) {} }
      data.comprobante = { fecha: fechaPago || hoy, ref: referencia, subidoEn: new Date().toISOString() };
      const datas = Buffer.from(JSON.stringify(data)).toString("base64");
      if (attId) await executeKw("ir.attachment", "write", [[attId], { datas }]);
      else await executeKw("ir.attachment", "create", [{ name: COB, res_model: "sale.order", res_id: o.id, type: "binary", mimetype: "application/json", datas }]);
      await executeKw("sale.order", "message_post", [[o.id]], {
        body: `💵 El cliente subió COMPROBANTE DE PAGO desde su estado de cuenta. Ref: ${referencia || "(sin referencia)"} · Fecha de pago: ${fechaPago || hoy}. Pendiente de conciliar.`,
      }).catch(() => {});
    }

    const admin = (process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "");
    if (admin && process.env.WHATSAPP_TOKEN) {
      await enviarTexto(admin, `💵 *Comprobante de pago recibido*\n${nombreCliente}\nÓrdenes: ${ordenes.map((o) => o.name).join(", ")}\nRef: ${referencia || "—"} · Fecha: ${fechaPago || hoy}\n\nRevisa y concilia en el portal de cobranza.`).catch(() => {});
    }
    return json({ ok: true, ordenes: ordenes.map((o) => o.name) });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
