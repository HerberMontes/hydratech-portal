// netlify/functions/lib/cobranza-motor.js
// MOTOR DE RECORDATORIOS DE COBRANZA — 3 plantillas (Claude Design) + cadencia.
//
// CADENCIA (benchmark B2B, días hábiles vía cron L-V):
//  · Falta SOLPED  (entregado sin solped):  1er aviso al día 3, luego cada 4 días.
//  · Falta OC      (solped sin OC):         1er aviso al día 5, luego cada 5 días.
//  · Pago (acuse registrado, corre crédito) por HITOS, una sola vez cada uno:
//      t5  = faltan ≤5 días        → nivel POR VENCER
//      d0  = vence hoy             → nivel HOY
//      d3  = 3-6 días vencida      → nivel VENCIDA
//      d7  = 7-14 días vencida     → nivel VENCIDA (+CC a dirección)
//      d15 = 15-21 días            → nivel CRÍTICA (+actividad LLAMAR al responsable)
//      w#  = semanal del día 22 al 59
//      q#  = quincenal del día 60 en adelante
//  · Estado de cuenta MENSUAL: día 1 del mes a todo cliente con saldo.
// Cada aviso queda registrado por orden en portal_cobranza.json → avisos,
// y como constancia en el chatter. Respeta COBRANZA_CORREO_PRUEBA y CC.
import { executeKw } from "./odoo.js";
import { P_SOLPED, P_OC, plantilla3Nivel, llenar, filaVencida, filaPorVencer } from "./cobranza-plantillas.js";
import { enviarTexto } from "./whatsapp.js";
import { urlEdocta } from "../edocta.js";

const DESDE = process.env.REPORTES_DESDE || "";
const EXTRA = (process.env.COBRANZA_EXTRA || "").split(",").map((s) => s.trim()).filter(Boolean);
const CORREO_PRUEBA = (process.env.COBRANZA_CORREO_PRUEBA || "").trim();
const CREDITO_DEFAULT = parseInt(process.env.COBRANZA_CREDITO_DIAS || "30", 10) || 30;
const CC = (process.env.COBRANZA_CC || "").trim();
const DIRECCION = (process.env.COBRANZA_ESCALA_CORREO || CC).trim(); // copia extra desde d7
const RESPONSABLE_LLAMADA = parseInt(process.env.COBRANZA_LLAMADA_UID || "0", 10) || null; // user Odoo para la actividad LLAMAR
const VARS_FIJAS = {
  BENEFICIARIO: (process.env.COBRANZA_BENEFICIARIO || "HydraTech Group").trim(),
  BANCO: (process.env.COBRANZA_BANCO || "").trim(),
  CLABE: (process.env.COBRANZA_CLABE || "").trim(),
  CORREO_CONTACTO: (process.env.COBRANZA_CORREO_CONTACTO || "administracion@hydratechgroup.mx").trim(),
  TELEFONO: (process.env.COBRANZA_TELEFONO || "").trim(),
  LOGO_URL: (process.env.COBRANZA_LOGO_URL || (process.env.URL ? String(process.env.URL).replace(/\/+$/, "") + "/assets/hydratech-wordmark-white.png" : "")).trim(),
};

const COB = "portal_cobranza.json", REP = "portal_reporte.json";
const ACUSE_PREFIX = "portal_acuse", EVID_PREFIX = "portal_evidencia";
const DAY = 86400000;
const hoyISO = () => new Date().toISOString().slice(0, 10);
const mxn = (n) => "$" + (Number(n) || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtF = (s) => { if (!s) return "—"; const p = String(s).slice(0, 10).split("-"); const M = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"]; return (+p[2]) + " " + M[(+p[1]) - 1] + " " + p[0]; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
function AND(subs) { subs = subs.filter((s) => s && s.length); if (!subs.length) return []; let d = []; for (let i = 0; i < subs.length - 1; i++) d.push("&"); for (const s of subs) d = d.concat(s); return d; }
function parseDate(s) { if (!s) return null; const t = Date.parse(String(s).replace(" ", "T") + (String(s).length <= 10 ? "T00:00:00Z" : "Z")); return isNaN(t) ? null : t; }
function daysSince(s, now) { const t = parseDate(s); return t == null ? null : Math.max(0, Math.round((now - t) / DAY)); }
function addDays(s, n) { const t = parseDate(s); if (t == null) return ""; return new Date(t + n * DAY).toISOString().slice(0, 10); }

/* Hito de pago según días para pagar (dp) / días vencida (dv=-dp) */
function hitoPago(dp) {
  const dv = -dp;
  if (dp >= 1 && dp <= 5) return { hito: "t5", nivel: "porvencer" };
  if (dv === 0) return { hito: "d0", nivel: "hoy" };
  if (dv >= 3 && dv < 7) return { hito: "d3", nivel: "vencida" };
  if (dv >= 7 && dv < 15) return { hito: "d7", nivel: "vencida" };
  if (dv >= 15 && dv < 22) return { hito: "d15", nivel: "critica" };
  if (dv >= 22 && dv < 60) return { hito: "w" + Math.floor((dv - 15) / 7), nivel: "critica" };
  if (dv >= 60) return { hito: "q" + Math.floor((dv - 60) / 14), nivel: "critica" };
  return null; // dp>5 o dv 1-2 (entre d0 y d3): sin correo
}

async function enviarCorreo({ asunto, html, destino, ccExtra }) {
  const vals = { subject: asunto, body_html: html, email_to: destino, auto_delete: false };
  const ccs = [CC, ccExtra].filter(Boolean).join(",");
  if (ccs) vals.email_cc = ccs;
  const mailId = await executeKw("mail.mail", "create", [vals]);
  await executeKw("mail.mail", "send", [[mailId]]).catch(() => {});
  return mailId;
}
async function registrarAviso(orden, tipo, hito) {
  const data = { ...(orden._cob || {}) };
  data.avisos = data.avisos || {};
  if (tipo === "pago") { data.avisos.pago = data.avisos.pago || {}; data.avisos.pago[hito] = hoyISO(); }
  else { data.avisos[tipo] = (data.avisos[tipo] || []).concat(hoyISO()); }
  data.ultimoRecordatorio = hoyISO();
  const datas = Buffer.from(JSON.stringify(data)).toString("base64");
  if (orden._attId) await executeKw("ir.attachment", "write", [[orden._attId], { datas }]).catch(() => {});
  else await executeKw("ir.attachment", "create", [{ name: COB, res_model: "sale.order", res_id: orden.id, type: "binary", mimetype: "application/json", datas }]).catch(() => {});
  orden._cob = data;
}

export async function correrCobranza({ enviar = false, manual = null } = {}) {
  const now = Date.now();
  const hoy = hoyISO();

  /* 1) Universo */
  const subs = [];
  if (DESDE && EXTRA.length) subs.push(["|", ["date_order", ">=", DESDE + " 00:00:00"], ["name", "in", EXTRA]]);
  else if (DESDE) subs.push([["date_order", ">=", DESDE + " 00:00:00"]]);
  else if (EXTRA.length) subs.push([["name", "in", EXTRA]]);
  subs.push([["state", "in", ["sale", "done"]]]);
  const orders = await executeKw("sale.order", "search_read", [AND(subs)],
    { fields: ["id", "name", "partner_id", "amount_total", "payment_term_id", "invoice_ids", "date_order"], limit: 300 });
  if (!orders.length) return { ok: true, hoy, solped: [], oc: [], clientes: [], nota: "Sin órdenes en cobranza." };
  const ids = orders.map((o) => o.id);

  /* 2) Adjuntos: cobranza, acuse, reporte, evidencia */
  const atts = await executeKw("ir.attachment", "search_read",
    [[["res_model", "=", "sale.order"], ["res_id", "in", ids],
      "|", "|", "|", ["name", "=", COB], ["name", "like", ACUSE_PREFIX + "%"], ["name", "=", REP], ["name", "like", EVID_PREFIX + "%"]]],
    { fields: ["id", "res_id", "name", "datas"], limit: 2000 });
  const cobBy = {}, cobAtt = {}, acuseBy = {}, evidBy = {}, repOkBy = {};
  for (const a of atts) {
    if (a.name === COB) { cobAtt[a.res_id] = a.id; try { cobBy[a.res_id] = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {} }
    else if (a.name.startsWith(ACUSE_PREFIX)) acuseBy[a.res_id] = true;
    else if (a.name === REP) { try { const r = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); if (r && r.status === "approved") repOkBy[a.res_id] = r.approvedAt || ""; } catch (e) {} }
    else evidBy[a.res_id] = true;
  }

  /* 3) Crédito por término + montos facturados + nota de servicio */
  const termIds = [...new Set(orders.map((o) => Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null).filter(Boolean))];
  const daysByTerm = {};
  if (termIds.length) {
    let lines = await executeKw("account.payment.term.line", "search_read", [[["payment_id", "in", termIds]]], { fields: ["payment_id", "nb_days"], limit: 500 }).catch(() => null);
    if (!lines) lines = await executeKw("account.payment.term.line", "search_read", [[["payment_id", "in", termIds]]], { fields: ["payment_id", "days"], limit: 500 }).catch(() => null);
    for (const l of (lines || [])) { const tid = Array.isArray(l.payment_id) ? l.payment_id[0] : l.payment_id; const d = Number(l.nb_days != null ? l.nb_days : l.days) || 0; daysByTerm[tid] = Math.max(daysByTerm[tid] || 0, d); }
  }
  const facIds = [...new Set(orders.flatMap((o) => Array.isArray(o.invoice_ids) ? o.invoice_ids : []))];
  const factBy = {}, folioFacBy = {}, saldoBy = {};
  if (facIds.length) {
    const moves = await executeKw("account.move", "search_read",
      [[["id", "in", facIds], ["state", "=", "posted"], ["move_type", "in", ["out_invoice", "out_refund"]]]],
      { fields: ["id", "amount_total", "amount_residual", "move_type", "name", "invoice_origin"], limit: 1000 }).catch(() => []);
    for (const o of orders) {
      let t = 0, saldo = 0, hayFactura = false, folios = [];
      for (const mid of (Array.isArray(o.invoice_ids) ? o.invoice_ids : [])) {
        const m = moves.find((x) => x.id === mid); if (!m) continue;
        const sig = m.move_type === "out_refund" ? -1 : 1;
        t += sig * (m.amount_total || 0);
        saldo += sig * (m.amount_residual != null ? m.amount_residual : m.amount_total || 0);
        if (m.move_type === "out_invoice") { folios.push(m.name); hayFactura = true; }
      }
      if (t > 0) factBy[o.id] = t;
      // SALDO REAL POR COBRAR según Odoo (descuenta pagos y abonos registrados en contabilidad)
      if (hayFactura) saldoBy[o.id] = Math.max(0, saldo);
      folioFacBy[o.id] = folios.join(", ");
    }
  }
  const notas = await executeKw("sale.order.line", "search_read",
    [[["order_id", "in", ids], ["display_type", "=", "line_note"]]],
    { fields: ["order_id", "name", "sequence"], order: "sequence asc", limit: 600 }).catch(() => []);
  const notaBy = {};
  for (const n of notas) { const oid = Array.isArray(n.order_id) ? n.order_id[0] : n.order_id; if (notaBy[oid] === undefined) notaBy[oid] = (n.name || "").trim(); }

  /* 4) Clasificar cada orden */
  const solpedList = [], ocList = [], porCliente = {};
  for (const o of orders) {
    const cob = cobBy[o.id] || {};
    if (cob.archivada) continue;
    const pagado = !!cob.pago;
    if (pagado) continue;
    const tieneEvid = !!repOkBy[o.id] || !!evidBy[o.id] || !!cob.evidenciaFecha;
    const solped = (cob.solped || "").trim(), ocRef = (cob.oc || "").trim();
    const tieneAcuse = (!!acuseBy[o.id] || !!cob.acuseFecha) && !!cob.acuseFecha;
    const monto = factBy[o.id] != null ? factBy[o.id] : (o.amount_total || 0);
    const pid = Array.isArray(o.partner_id) ? o.partner_id[0] : 0;
    const pname = Array.isArray(o.partner_id) ? o.partner_id[1] : "—";
    const base = { id: o.id, folio: o.name, cliente: pname, partnerId: pid, monto,
      descripcion: notaBy[o.id] || o.name, _cob: cob, _attId: cobAtt[o.id] || null };

    if (tieneAcuse) {
      // Si Odoo reporta la factura saldada, se considera PAGADA aunque el
      // portal no tenga el pago capturado (la contabilidad manda).
      if (saldoBy[o.id] === 0) continue;
      const termId = Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null;
      const plazo = termId != null && daysByTerm[termId] != null ? daysByTerm[termId] : CREDITO_DEFAULT;
      const fechaPago = addDays(cob.acuseFecha, plazo);
      const fp = parseDate(fechaPago); if (fp == null) continue;
      const dp = Math.round((fp - now) / DAY);
      const montoPend = saldoBy[o.id] != null ? saldoBy[o.id] : base.monto;
      (porCliente[pid] = porCliente[pid] || { partnerId: pid, cliente: pname, ordenes: [] }).ordenes.push({
        ...base, monto: montoPend, fechaPago, diasParaPago: dp, vencida: dp < 0,
        factura: folioFacBy[o.id] || "", entrega: cob.evidenciaFecha || repOkBy[o.id] || "" });
    } else if (solped && !ocRef) {
      const dias = daysSince(cob.solpedFecha || cob.updatedAt, now) || 0;
      const avisos = (cob.avisos && cob.avisos.oc) || [];
      const ultimo = avisos.length ? daysSince(avisos[avisos.length - 1], now) : null;
      const toca = dias >= 5 && (ultimo == null || ultimo >= 5);
      ocList.push({ ...base, solped, posicion: (cob.posicion || "").trim(), fechaSolped: cob.solpedFecha || "", dias, toca, avisosPrevios: avisos.length });
    } else if (tieneEvid && !solped && !ocRef) {
      const evidFecha = cob.evidenciaFecha || repOkBy[o.id] || o.date_order;
      const dias = daysSince(evidFecha, now) || 0;
      const avisos = (cob.avisos && cob.avisos.solped) || [];
      const ultimo = avisos.length ? daysSince(avisos[avisos.length - 1], now) : null;
      const toca = dias >= 3 && (ultimo == null || ultimo >= 4);
      solpedList.push({ ...base, evidFecha, dias, toca, avisosPrevios: avisos.length });
    }
  }

  /* 5) Correos de contacto (partner de la orden, respaldo en el padre) */
  const pidsTodos = [...new Set([...solpedList, ...ocList].map((x) => x.partnerId).concat(Object.keys(porCliente).map(Number)))].filter(Boolean);
  const partners = pidsTodos.length ? await executeKw("res.partner", "read", [pidsTodos, ["name", "email", "parent_id"]]).catch(() => []) : [];
  const emailDe = {}, nombreDe = {}, padreDe = {};
  partners.forEach((p) => { emailDe[p.id] = (p.email || "").trim(); nombreDe[p.id] = p.name || ""; padreDe[p.id] = Array.isArray(p.parent_id) ? p.parent_id[0] : null; });
  const padres = [...new Set(partners.filter((p) => !emailDe[p.id] && padreDe[p.id]).map((p) => padreDe[p.id]))];
  if (padres.length) {
    const pp = await executeKw("res.partner", "read", [padres, ["email"]]).catch(() => []);
    const eP = {}; pp.forEach((p) => { eP[p.id] = (p.email || "").trim(); });
    pidsTodos.forEach((id) => { if (!emailDe[id] && padreDe[id] && eP[padreDe[id]]) emailDe[id] = eP[padreDe[id]]; });
  }

  /* 5b) DIRECTORIO DE COBRANZA por cliente (contactos propios por nivel) */
  const DIR_NOMBRE = "portal_cobranza_contactos.json";
  const dirBy = {};
  if (pidsTodos.length) {
    const dirs = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "res.partner"], ["res_id", "in", pidsTodos], ["name", "=", DIR_NOMBRE]]],
      { fields: ["res_id", "datas"], limit: 500 }).catch(() => []);
    for (const d of dirs) {
      try { const j = JSON.parse(Buffer.from(d.datas || "", "base64").toString("utf8"));
        if (j && Array.isArray(j.contactos)) dirBy[d.res_id] = j.contactos; } catch (e) {}
    }
  }
  const NIVELES_POR_TIPO = { solped: ["raso"], oc: ["raso", "supervisor"], pago: ["raso", "supervisor", "cxp"] };
  /* Destinatarios de un cliente para un tipo de recordatorio:
     correos y whatsapps del directorio en los niveles que tocan; si el
     directorio no tiene correos para ese cliente, respaldo = correo de Odoo. */
  function destinatarios(pid, tipo) {
    const niveles = NIVELES_POR_TIPO[tipo] || ["raso"];
    const dir = (dirBy[pid] || []).filter((c) => niveles.includes(c.nivel));
    const correos = [...new Set(dir.map((c) => (c.correo || "").trim()).filter(Boolean))];
    const whats = [...new Set(dir.map((c) => (c.whatsapp || "").replace(/\D/g, "")).filter((w) => w.length >= 12))];
    const nombreRaso = (dir.find((c) => c.nivel === "raso") || dir[0] || {}).nombre || "";
    if (!correos.length && emailDe[pid]) correos.push(emailDe[pid]);
    return { correos, whats, nombreRaso };
  }
  const WA_ACTIVO = !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_ID;
  const WA_PRUEBA = CORREO_PRUEBA ? (process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "") : "";
  async function avisarWhats(whats, texto) {
    if (!WA_ACTIVO || !whats.length) return 0;
    const lista = WA_PRUEBA ? [WA_PRUEBA] : whats; // en modo prueba, solo a ti
    let n = 0;
    for (const w of lista) { try { await enviarTexto(w, texto); n++; } catch (e) {} }
    return n;
  }

  const resultado = { ok: true, hoy, enviados: [], solped: [], oc: [], clientes: [] };

  /* 6) PLANTILLA 1 — falta SolPed (por orden) */
  for (const s of solpedList) {
    const d = destinatarios(s.partnerId, "solped");
    const item = { folio: s.folio, cliente: s.cliente, partnerId: s.partnerId, servicio: s.descripcion, entregado: s.evidFecha || "", dias: s.dias, monto: s.monto, correo: d.correos.join(", ") || "—",
      whatsapps: d.whats.length, seEnvia: s.toca && (d.correos.length > 0 || d.whats.length > 0),
      omitido: !s.toca ? "aún no toca (cadencia día 3, luego cada 4)" : (!d.correos.length && !d.whats.length ? "SIN CORREO ni WhatsApp (directorio y Odoo vacíos)" : undefined) };
    resultado.solped.push(item);
    if (enviar && item.seEnvia) {
      const html = llenar(P_SOLPED, { ...VARS_FIJAS, CLIENTE: esc(s.cliente), CONTACTO: esc(d.nombreRaso || nombreDe[s.partnerId] || s.cliente),
        FOLIO: s.folio, DESCRIPCION: esc(s.descripcion), FECHA_EVIDENCIA: fmtF(s.evidFecha), MONTO: mxn(s.monto), DIAS: s.dias, FECHA: fmtF(hoy) });
      if (d.correos.length) await enviarCorreo({ asunto: `Servicio entregado — pendiente su SolPed · ${s.folio}`, html, destino: CORREO_PRUEBA || d.correos.join(",") });
      const nWA = await avisarWhats(d.whats, `🔔 *HydraTech* · ${s.cliente}\nEl servicio *${s.folio}* (${s.descripcion}) está entregado y firmado desde hace *${s.dias} días* y aún no tenemos su SolPed. ¿Nos apoya generándola? Su estado de cuenta: ${urlEdocta(s.partnerId)}`);
      await executeKw("sale.order", "message_post", [[s.id]], { body: `Recordatorio de SOLPED enviado (día ${s.dias}) → correo: ${CORREO_PRUEBA || d.correos.join(", ") || "—"} · WhatsApp: ${nWA}.` }).catch(() => {});
      await registrarAviso(s, "solped");
      resultado.enviados.push({ tipo: "solped", folio: s.folio });
    }
  }

  /* 7) PLANTILLA 2 — falta OC (por orden) */
  for (const s of ocList) {
    const d = destinatarios(s.partnerId, "oc");
    const item = { folio: s.folio, cliente: s.cliente, partnerId: s.partnerId, servicio: s.descripcion, entregado: (s._cob && s._cob.evidenciaFecha) || "", solped: s.solped, dias: s.dias, monto: s.monto, correo: d.correos.join(", ") || "—",
      whatsapps: d.whats.length, seEnvia: s.toca && (d.correos.length > 0 || d.whats.length > 0),
      omitido: !s.toca ? "aún no toca (cadencia día 5, luego cada 5)" : (!d.correos.length && !d.whats.length ? "SIN CORREO ni WhatsApp" : undefined) };
    resultado.oc.push(item);
    if (enviar && item.seEnvia) {
      const html = llenar(P_OC, { ...VARS_FIJAS, CLIENTE: esc(s.cliente), CONTACTO: esc(d.nombreRaso || nombreDe[s.partnerId] || s.cliente),
        FOLIO: s.folio, DESCRIPCION: esc(s.descripcion), FECHA_EVIDENCIA: fmtF(s._cob.evidenciaFecha || ""), MONTO: mxn(s.monto),
        DIAS: s.dias, SOLPED: esc(s.solped), POSICION: esc(s.posicion || "—"), FECHA_SOLPED: fmtF(s.fechaSolped), FECHA: fmtF(hoy) });
      if (d.correos.length) await enviarCorreo({ asunto: `SolPed ${s.solped} pendiente de OC — ${s.dias} días · ${s.folio}`, html, destino: CORREO_PRUEBA || d.correos.join(",") });
      const nWA = await avisarWhats(d.whats, `🔔 *HydraTech* · ${s.cliente}\nLa SolPed *${s.solped}* lleva *${s.dias} días* sin convertirse en orden de compra (servicio ${s.folio}, ya entregado). Sin la OC no podemos facturar. Su estado de cuenta: ${urlEdocta(s.partnerId)}`);
      await executeKw("sale.order", "message_post", [[s.id]], { body: `Recordatorio de OC (SolPed ${s.solped}, día ${s.dias}) → correo: ${CORREO_PRUEBA || d.correos.join(", ") || "—"} · WhatsApp: ${nWA}.` }).catch(() => {});
      await registrarAviso(s, "oc");
      resultado.enviados.push({ tipo: "oc", folio: s.folio });
    }
  }

  /* 8) PLANTILLA 3 — estado de cuenta por cliente, por hitos */
  const esDia1 = new Date().getUTCDate() === 1;
  for (const pid of Object.keys(porCliente)) {
    const c = porCliente[pid];
    c.ordenes.sort((a, b) => a.diasParaPago - b.diasParaPago);
    const peor = c.ordenes[0];
    const h = hitoPago(peor.diasParaPago);
    const mensualKey = "m" + hoy.slice(0, 7);
    const yaHito = h && peor._cob && peor._cob.avisos && peor._cob.avisos.pago && peor._cob.avisos.pago[h.hito];
    const yaMensual = peor._cob && peor._cob.avisos && peor._cob.avisos.pago && peor._cob.avisos.pago[mensualKey];
    let hitoFinal = null, nivel = null;
    if (h && !yaHito) { hitoFinal = h.hito; nivel = h.nivel; }
    else if (esDia1 && !yaMensual) { hitoFinal = mensualKey; nivel = peor.diasParaPago < 0 ? (-peor.diasParaPago >= 15 ? "critica" : "vencida") : "porvencer"; }
    const d = destinatarios(c.partnerId, "pago");
    const correo = d.correos.join(",");
    const venc = c.ordenes.filter((o) => o.vencida), porv = c.ordenes.filter((o) => !o.vencida);
    const totV = venc.reduce((a, o) => a + o.monto, 0), totT = c.ordenes.reduce((a, o) => a + o.monto, 0);
    const item = { cliente: c.cliente, partnerId: c.partnerId, correo: correo || "—", totalVencido: totV, totalGeneral: totT,
      peorDias: peor.diasParaPago, hito: hitoFinal || "—", nivel: nivel || "—",
      seEnvia: !!hitoFinal && (!!correo || d.whats.length > 0),
      omitido: !hitoFinal ? (h && yaHito ? `hito ${h.hito} ya enviado` : "sin hito hoy") : (!correo && !d.whats.length ? "SIN CORREO ni WhatsApp" : undefined),
      ordenes: c.ordenes.map((o) => ({ folio: o.folio, factura: o.factura || "", servicio: o.descripcion || "", vence: o.fechaPago, dias: o.diasParaPago, monto: o.monto, comprobante: !!(o._cob && o._cob.comprobante && !o._cob.pago) })) };
    resultado.clientes.push(item);
    const forzar = manual && Number(manual.partnerId) === c.partnerId;
    if ((enviar && item.seEnvia) || forzar) {
      const destinoReal = forzar ? String(manual.correo || correo).trim() : correo;
      const nivelUso = nivel || (peor.diasParaPago < 0 ? (-peor.diasParaPago >= 15 ? "critica" : "vencida") : (peor.diasParaPago === 0 ? "hoy" : "porvencer"));
      let tpl = plantilla3Nivel(nivelUso);
      // El CTA de comprobante deja el mailto y abre la página viva del cliente
      tpl = tpl.split("mailto:{{CORREO_CONTACTO}}?subject=Comprobante%20de%20pago%20-%20{{CLIENTE}}").join(urlEdocta(c.partnerId));
      const html = llenar(tpl, { ...VARS_FIJAS, CLIENTE: esc(c.cliente), CONTACTO: esc(d.nombreRaso || nombreDe[c.partnerId] || c.cliente), FECHA: fmtF(hoy),
        DIAS_PARA: Math.max(0, peor.diasParaPago), DIAS_VENCIDO: Math.max(0, -peor.diasParaPago),
        TABLA_VENCIDO: venc.map((o) => filaVencida({ folio: o.folio, factura: esc(o.factura), entrega: fmtF(o.entrega), vence: fmtF(o.fechaPago), dias: -o.diasParaPago, monto: mxn(o.monto) })).join("") || filaVencida({ folio: "—", factura: "", entrega: "—", vence: "—", dias: 0, monto: mxn(0) }),
        TABLA_POR_VENCER: porv.map((o) => filaPorVencer({ folio: o.folio, factura: esc(o.factura), entrega: fmtF(o.entrega), vence: fmtF(o.fechaPago), dias: o.diasParaPago, monto: mxn(o.monto) })).join("") || filaPorVencer({ folio: "—", factura: "", entrega: "—", vence: "—", dias: 0, monto: mxn(0) }),
        TOTAL_VENCIDO: mxn(totV), TOTAL_GENERAL: mxn(totT) });
      const asunto = nivelUso === "porvencer" ? `Estado de cuenta — factura próxima a vencer · ${c.cliente}`
        : nivelUso === "hoy" ? `Su factura vence HOY · ${c.cliente}`
        : `REQUERIMIENTO DE PAGO — ${Math.max(0, -peor.diasParaPago)} días de vencida · ${c.cliente}`;
      if (CORREO_PRUEBA || destinoReal) await enviarCorreo({ asunto, html, destino: CORREO_PRUEBA || destinoReal, ccExtra: ["d7","d15"].includes(hitoFinal) || String(hitoFinal).startsWith("w") || String(hitoFinal).startsWith("q") ? DIRECCION : "" });
      const totVtx = mxn(totV);
      const nWA = await avisarWhats(d.whats, nivelUso === "porvencer"
        ? `🔔 *HydraTech* · ${c.cliente}\nSu factura vence en *${Math.max(0, peor.diasParaPago)} días*. Su estado de cuenta y datos de pago: ${urlEdocta(c.partnerId)}`
        : nivelUso === "hoy"
        ? `🔔 *HydraTech* · ${c.cliente}\nSu factura *vence HOY*. Su estado de cuenta y datos de pago: ${urlEdocta(c.partnerId)} ¿Nos confirma la programación del pago?`
        : `🔴 *HydraTech — Requerimiento de pago* · ${c.cliente}\n*${totVtx}* con *${Math.max(0, -peor.diasParaPago)} días* de vencido. Su estado de cuenta: ${urlEdocta(c.partnerId)} — agradecemos programar el pago o indicarnos fecha compromiso.`);
      for (const o of c.ordenes) {
        await executeKw("sale.order", "message_post", [[o.id]], { body: `Estado de cuenta (${nivelUso}, hito ${hitoFinal || "manual"}) → correo: ${CORREO_PRUEBA || destinoReal || "—"} · WhatsApp: ${nWA}.` }).catch(() => {});
        await registrarAviso(o, "pago", hitoFinal || ("manual-" + hoy));
      }
      // Escalamiento humano: al hito d15 se crea la actividad LLAMAR
      if (hitoFinal === "d15") {
        try {
          const modelIds = await executeKw("ir.model", "search", [[["model", "=", "sale.order"]]], { limit: 1 });
          await executeKw("mail.activity", "create", [{
            res_model_id: modelIds[0], res_id: peor.id,
            summary: `LLAMAR a ${c.cliente} — ${mxn(totV)} vencido (${-peor.diasParaPago} días)`,
            date_deadline: hoy, ...(RESPONSABLE_LLAMADA ? { user_id: RESPONSABLE_LLAMADA } : {}),
          }]);
        } catch (e) {}
      }
      resultado.enviados.push({ tipo: "pago", cliente: c.cliente, hito: hitoFinal || "manual", nivel: nivelUso });
    }
  }

  resultado.resumen = { solpedPendientes: resultado.solped.length, ocPendientes: resultado.oc.length,
    clientesConSaldo: resultado.clientes.length, correosEnviados: resultado.enviados.length, modoPrueba: !!CORREO_PRUEBA };
  return resultado;
}
