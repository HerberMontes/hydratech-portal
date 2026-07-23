// netlify/functions/cotiza-solicitud.js
// FLUJO DE APROBACIÓN DEL COTIZADOR DE MANGUERAS
// El técnico ya NO crea cotizaciones: envía una SOLICITUD (vive como adjunto
// en el cliente dentro de Odoo). Dirección/administración recibe el correo con
// el botón ✅ APROBAR: al aprobar se crea la cotización en Odoo, se registra el
// censo de mangueras y nace la oportunidad en el CRM. El técnico ve el estado
// en su pestaña de Guardados (🟡 En aprobación → ✅ Cotizada S0XXX).
//
//   POST { action:"enviar", id?, nombre, clienteId, clienteNombre, areaTxt,
//          equipoTxt, areaId, equipoId, payload:{note,lines}, registro, total, piezas }
//   GET  ?estados=1,2,3          -> { estados: { id: {estado, folio} } }
//   GET  ?aprobar={id}.{firma}   -> aprueba (página HTML de confirmación)
import crypto from "node:crypto";
import { executeKw, checkToken, json } from "./lib/odoo.js";

const SECRET = process.env.FIRMA_SECRET || "hydratech";
const SITE = (process.env.URL || "").replace(/\/+$/, "");
const firma = (id) => crypto.createHmac("sha256", SECRET).update("solicitud:" + id).digest("hex").slice(0, 16);
const mxn = (n) => "$" + (Number(n) || 0).toLocaleString("es-MX", { minimumFractionDigits: 2 });
const esc = (x) => String(x == null ? "" : x).replace(/</g, "&lt;");

async function leer(attId) {
  const r = await executeKw("ir.attachment", "read", [[attId], ["id", "res_id", "datas", "name"]]).catch(() => []);
  if (!r.length) return null;
  try { return { attId, partnerId: r[0].res_id, doc: JSON.parse(Buffer.from(r[0].datas || "", "base64").toString("utf8")) }; }
  catch (e) { return null; }
}
const guardarDoc = (attId, doc) => executeKw("ir.attachment", "write", [[attId], { datas: Buffer.from(JSON.stringify(doc)).toString("base64") }]);

function paginaHTML(titulo, cuerpo, ok) {
  return new Response(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)}</title>
  <style>body{margin:0;background:#eef0f4;font-family:system-ui,sans-serif;color:#1b2138;display:grid;place-items:center;min-height:100vh;padding:20px}
  .c{background:#fff;border:1px solid #dfe4ee;border-radius:16px;max-width:480px;padding:30px;text-align:center}
  .b{background:#141829;border-bottom:3px solid #263370;margin:-30px -30px 22px;border-radius:15px 15px 0 0;padding:14px;color:#7e8cc4;font-size:11px;letter-spacing:.14em}
  h1{font-size:${ok ? "44px" : "34px"};margin:0 0 6px}p{color:#46506a;font-size:15px;line-height:1.6}</style></head>
  <body><div class="c"><div class="b">HYDRATECH · COTIZADOR DE MANGUERAS</div><h1>${ok ? "✅" : "⚠️"}</h1><h2 style="margin:0 0 10px">${esc(titulo)}</h2><p>${cuerpo}</p></div></body></html>`,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default async (req) => {
  const u = new URL(req.url);

  /* ============ APROBAR (link del correo; el token es la llave) ============ */
  const tok = u.searchParams.get("aprobar");
  if (req.method === "GET" && tok) {
    const m = /^(\d+)\.([a-f0-9]{16})$/.exec(tok);
    if (!m || firma(+m[1]) !== m[2]) return paginaHTML("Link no válido", "Solicita un correo de aprobación nuevo.", false);
    const s = await leer(+m[1]);
    if (!s) return paginaHTML("Solicitud no encontrada", "Pudo haber sido eliminada.", false);
    const d = s.doc;
    if (d.estado === "cotizada") return paginaHTML("Ya estaba cotizada", `Esta solicitud ya generó la cotización <b>${esc(d.folio)}</b>. No se duplicó nada.`, true);
    try {
      // 1) Cotización en Odoo (reusa el motor existente, incluido su correo de aviso)
      const rc = await fetch(SITE + "/api/odoo-cotizar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId: Number(d.clienteId), note: d.payload.note, lines: d.payload.lines }),
      }).then((r) => r.json());
      if (!rc.ok) return paginaHTML("No se pudo cotizar", esc(rc.error || "Error en Odoo."), false);
      // 2) Censo de mangueras del cliente
      await fetch(SITE + "/api/mangueras-registrar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId: Number(d.clienteId), areaId: d.areaId || "", equipoId: d.equipoId || "", areaNombre: d.areaTxt || "", equipoNombre: d.equipoTxt || "", folio: rc.folio, mangueras: d.registro || [] }),
      }).catch(() => {});
      // 3) Oportunidad en el CRM, ligada a la cotización
      try {
        const leadId = await executeKw("crm.lead", "create", [{
          name: `Mangueras · ${d.clienteNombre || "Cliente"} · ${d.equipoTxt || d.areaTxt || ""}`.trim(),
          partner_id: Number(d.clienteId), type: "opportunity",
          expected_revenue: Number(d.total) || 0,
          description: `Solicitud del cotizador de mangueras aprobada.\nCotización: ${rc.folio}\nÁrea: ${d.areaTxt || ""} · Equipo: ${d.equipoTxt || ""}\nPiezas: ${d.piezas || (d.registro || []).length}`,
        }]);
        await executeKw("sale.order", "write", [[rc.orderId], { opportunity_id: leadId }]).catch(() => {});
      } catch (e) {}
      // 4) Marcar la solicitud
      d.estado = "cotizada"; d.folio = rc.folio; d.orderId = rc.orderId; d.aprobadaEn = new Date().toISOString();
      await guardarDoc(s.attId, d);
      return paginaHTML("Cotización creada", `Se generó <b>${esc(rc.folio)}</b> en Odoo (borrador), se registró el censo de mangueras y la oportunidad entró al CRM.<br><br><a href="${rc.link}" style="color:#3a52a8;font-weight:bold">Abrir en Odoo →</a>`, true);
    } catch (e) {
      return paginaHTML("Error al aprobar", esc(e.message || e), false);
    }
  }

  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);

  /* ============ ESTADOS (para los chips de Guardados del técnico) ============ */
  if (req.method === "GET") {
    const ids = (u.searchParams.get("estados") || "").split(",").map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 60);
    if (!ids.length) return json({ ok: false, error: "Falta estados=ids" }, 400);
    const out = {};
    for (const id of ids) {
      const s = await leer(id);
      if (s) out[id] = { estado: s.doc.estado || "pendiente", folio: s.doc.folio || "" };
    }
    return json({ ok: true, estados: out });
  }

  /* ============ ENVIAR A APROBACIÓN ============ */
  if (req.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);
  const b = await req.json().catch(() => ({}));
  if (b.action !== "enviar") return json({ ok: false, error: "Acción no válida." }, 400);
  if (!b.clienteId || !b.payload || !Array.isArray(b.payload.lines) || !b.payload.lines.length)
    return json({ ok: false, error: "Faltan cliente o mangueras." }, 400);

  const doc = {
    estado: "pendiente",
    nombre: String(b.nombre || "Solicitud").slice(0, 120),
    clienteId: Number(b.clienteId), clienteNombre: String(b.clienteNombre || "").slice(0, 140),
    areaTxt: String(b.areaTxt || "").slice(0, 80), equipoTxt: String(b.equipoTxt || "").slice(0, 80),
    areaId: b.areaId || "", equipoId: b.equipoId || "",
    payload: { note: String(b.payload.note || "").slice(0, 300), lines: b.payload.lines.slice(0, 60) },
    registro: Array.isArray(b.registro) ? b.registro.slice(0, 200) : [],
    total: Number(b.total) || 0, piezas: Number(b.piezas) || 0,
    enviadaEn: new Date().toISOString(),
  };

  let attId = parseInt(b.id, 10) || null;
  if (attId) {
    const prev = await leer(attId);
    if (!prev) attId = null;
    else if (prev.doc.estado === "cotizada")
      return json({ ok: false, code: "cotizada", folio: prev.doc.folio, error: `Esa solicitud ya fue cotizada (${prev.doc.folio}). Se enviará como solicitud nueva.` }, 409);
    else { doc.creadaEn = prev.doc.creadaEn || prev.doc.enviadaEn; await guardarDoc(attId, doc); }
  }
  if (!attId) {
    doc.creadaEn = doc.enviadaEn;
    attId = await executeKw("ir.attachment", "create", [{
      name: `portal_solicitud_${Date.now()}.json`, res_model: "res.partner", res_id: doc.clienteId,
      type: "binary", mimetype: "application/json", datas: Buffer.from(JSON.stringify(doc)).toString("base64"),
    }]);
  }

  /* Correo con botón APROBAR */
  try {
    const destino = (process.env.COTIZA_CORREO_ADMIN || "").trim();
    const copia = (process.env.COTIZA_CORREO_DIRECCION || "").trim();
    if (destino || copia) {
      const urlAprobar = `${SITE}/api/cotiza-solicitud?aprobar=${attId}.${firma(attId)}`;
      const td = "padding:7px 10px;border-bottom:1px solid #eceef4;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1b2138;";
      const th = "padding:7px 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#8a93a8;border-bottom:2px solid #e6e9f0;";
      const filas = doc.payload.lines.map((l) => {
        const q = Number(l.qty) > 0 ? Number(l.qty) : 1;
        return `<tr><td style="${td}">${esc(l.name)}</td><td align="center" style="${td}">${q}</td><td align="right" style="${td}">${mxn(l.price)}</td><td align="right" style="${td}font-weight:bold;">${mxn((Number(l.price) || 0) * q)}</td></tr>`;
      }).join("");
      const html = `<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;">
        <div style="background:#141829;border-bottom:3px solid #263370;padding:16px 20px;color:#ffffff;font-weight:bold;font-size:16px;">Solicitud de cotización — requiere tu APROBACIÓN</div>
        <div style="background:#ffffff;border:1px solid #e6e9f0;padding:18px 20px;">
          <p style="font-size:14px;color:#1b2138;margin:0 0 4px;"><b>${esc(doc.clienteNombre || "Cliente")}</b> · ${esc(doc.payload.note)}</p>
          <p style="font-size:12px;color:#8a93a8;margin:0 0 14px;">Enviada desde el cotizador de mangueras · ${esc(doc.nombre)}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr><th align="left" style="${th}">DESCRIPCIÓN</th><th style="${th}">CANT.</th><th align="right" style="${th}">P. UNIT</th><th align="right" style="${th}">IMPORTE</th></tr>
            ${filas}
            <tr><td colspan="3" align="right" style="padding:10px;font-family:Arial;font-size:13px;font-weight:bold;">TOTAL</td><td align="right" style="padding:10px;font-family:Arial;font-size:15px;font-weight:bold;color:#3a52a8;">${mxn(doc.total)}</td></tr>
          </table>
          <p style="margin:18px 0 0;text-align:center;"><a href="${urlAprobar}" style="background:#16a34a;color:#ffffff;text-decoration:none;padding:14px 26px;border-radius:9px;font-size:15px;font-weight:bold;display:inline-block;">✅ Aprobar y generar cotización</a></p>
          <p style="font-size:11px;color:#8a93a8;margin-top:14px;text-align:center;">Al aprobar: se crea la cotización en Odoo (borrador), se registra el censo de mangueras del cliente y la oportunidad entra al CRM. Nada se genera hasta que apruebes.</p>
        </div></div>`;
      const vals = { subject: `🟡 APROBAR cotización de mangueras · ${doc.clienteNombre || "Cliente"} · ${mxn(doc.total)}`, body_html: html, email_to: destino || copia, auto_delete: false };
      if (destino && copia && copia !== destino) vals.email_cc = copia;
      const mailId = await executeKw("mail.mail", "create", [vals]);
      await executeKw("mail.mail", "send", [[mailId]]).catch(() => {});
    }
  } catch (e) { console.error("correo solicitud:", e); }

  await executeKw("res.partner", "message_post", [[doc.clienteId]], { body: `🟡 Solicitud de cotización de mangueras enviada a aprobación (${doc.piezas} pza(s), ${mxn(doc.total)}).` }).catch(() => {});
  return json({ ok: true, id: attId, estado: "pendiente" });
};
