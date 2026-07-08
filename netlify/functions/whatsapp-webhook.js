// netlify/functions/whatsapp-webhook.js
// Bot de WhatsApp para técnicos. URL para Meta:  https://TU-SITIO/api/whatsapp-webhook
//
// Flujos:
//   1) Reporte de servicio: elegir orden -> 3 secciones por nota de voz
//      (hallazgos, actividades, plan) + fotos -> IA genera el reporte ->
//      se guarda como borrador "submitted" en la orden (mismo formato del
//      portal) -> te llega A TI por WhatsApp para validar -> al aprobar,
//      el técnico recibe el link de FIRMA para el cliente -> firmado = archivado.
//   2) Voz del cliente: nota de voz libre con todo lo que el cliente dijo y
//      lo que el técnico vio -> IA lo estructura -> se crea lead en el CRM
//      de Odoo + aviso a ti por WhatsApp.
//
// Variables de entorno nuevas:
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_VERIFY  (Meta)
//   ADMIN_WHATSAPP   -> tu número con lada país, ej. 5215512345678
//   FIRMA_SECRET     -> cualquier cadena secreta para los links de firma
//   TECNICOS_WHATSAPP (opcional) -> JSON {"5215511111111":"Juan Pérez"}
//   VENDEDORES_WHATSAPP (opcional) -> JSON {"7":"5215533333333","Luis García":"5215544444444"} (llave: id o nombre del usuario Odoo)
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { executeKw, json } from "./lib/odoo.js";
import { enviarTexto, enviarBotones, enviarLista, descargarMedia, leerMensaje } from "./lib/whatsapp.js";
import { transcribirAudio, generarReporteIA, estructurarVozCliente } from "./lib/reporte-ia.js";
import { crearOportunidadDePlan } from "./lib/crm-plan.js";

const VERIFY = process.env.WHATSAPP_VERIFY || "";
const ADMIN = (process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "");
const SECRET = process.env.FIRMA_SECRET || process.env.PORTAL_TOKEN || "hydratech";
const SITE = (process.env.URL || "").replace(/\/+$/, "");
const ATT_NAME = "portal_reporte.json";
const DESDE = process.env.REPORTES_DESDE || "";

const nombreTecnico = (tel) => {
  try { return (JSON.parse(process.env.TECNICOS_WHATSAPP || "{}")[tel]) || ""; } catch (e) { return ""; }
};

/* Vendedor dueño de un cliente: primero el comercial del contacto (user_id),
   si no tiene, el vendedor de su última orden de venta. */
async function vendedorDe(partnerId) {
  try {
    const p = await executeKw("res.partner", "read", [[partnerId]], { fields: ["user_id"] });
    let u = p && p[0] && p[0].user_id;
    if (!u) {
      const o = await executeKw("sale.order", "search_read", [[["partner_id", "child_of", partnerId]]],
        { fields: ["user_id"], limit: 1, order: "date_order desc" });
      u = o && o[0] && o[0].user_id;
    }
    return Array.isArray(u) ? { id: u[0], name: u[1] || "" } : null;
  } catch (e) { return null; }
}

/* WhatsApp del vendedor. VENDEDORES_WHATSAPP acepta como llave el ID de usuario
   de Odoo o el nombre: {"7":"5215511111111","Luis García":"5215522222222"} */
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
function waDeVendedor(v) {
  if (!v) return "";
  try {
    const map = JSON.parse(process.env.VENDEDORES_WHATSAPP || "{}");
    if (map[String(v.id)]) return String(map[String(v.id)]).replace(/\D/g, "");
    for (const k of Object.keys(map)) if (norm(k) === norm(v.name)) return String(map[k]).replace(/\D/g, "");
  } catch (e) {}
  return "";
}
const firmaToken = (id) => crypto.createHmac("sha256", SECRET).update(String(id)).digest("hex").slice(0, 24);

/* ============ Estado de conversación (Netlify Blobs) ============
   consistency:"strong" es OBLIGATORIO: con la consistencia por defecto
   (eventual), una invocación puede leer el estado viejo y el bot "olvida"
   en qué paso iba, regresando al menú a mitad del flujo. */
const store = () => getStore({ name: "wa-estado", consistency: "strong" });

/* ============ Fotos y notas: registros INDEPENDIENTES (a prueba de carreras) ============
   WhatsApp entrega varias fotos/audios en webhooks SIMULTÁNEOS. Si se guardaran
   dentro del estado, una invocación pisaría lo de la otra (así se perdían fotos
   y texto). Cada foto/nota se guarda como blob propio y se recolectan al final. */
const media = () => getStore({ name: "wa-media", consistency: "strong" });
const sufijo = (msg) => Date.now() + "-" + String(msg.id || Math.random()).slice(-10).replace(/[^A-Za-z0-9._-]/g, "");
const agregarNota = (tel, sec, texto, msg) => media().set(`nota:${tel}:${sec}:${sufijo(msg)}`, texto);
const agregarFoto = (tel, sec, dataURL, cap, msg) => media().set(`foto:${tel}:${sec}:${sufijo(msg)}`, JSON.stringify({ dataURL, sec, cap: cap || "" }));
const setPortada = (tel, dataURL) => media().set(`portada:${tel}`, dataURL);
async function contar(prefix) {
  const r = await media().list({ prefix }).catch(() => ({ blobs: [] }));
  return (r.blobs || []).length;
}
async function recolectar(tel) {
  const st = media();
  const notas = { hallazgos: [], actividades: [], plan: [], voz: [] };
  const rn = await st.list({ prefix: `nota:${tel}:` }).catch(() => ({ blobs: [] }));
  for (const b of (rn.blobs || []).sort((a, z) => a.key.localeCompare(z.key))) {
    const sec = b.key.split(":")[2];
    const v = await st.get(b.key).catch(() => "");
    if (notas[sec] !== undefined && v) notas[sec].push(v);
  }
  const fotos = [];
  const rf = await st.list({ prefix: `foto:${tel}:` }).catch(() => ({ blobs: [] }));
  for (const b of (rf.blobs || []).sort((a, z) => a.key.localeCompare(z.key))) {
    try { const v = await st.get(b.key); if (v) fotos.push(JSON.parse(v)); } catch (e) {}
  }
  const portada = await st.get(`portada:${tel}`).catch(() => null);
  return {
    notas: { h: notas.hallazgos.join(" "), a: notas.actividades.join(" "), p: notas.plan.join(" "), voz: notas.voz.join("\n") },
    fotos, portada: portada || null,
  };
}
async function limpiarMedia(tel) {
  const st = media();
  for (const pref of [`nota:${tel}:`, `foto:${tel}:`]) {
    const r = await st.list({ prefix: pref }).catch(() => ({ blobs: [] }));
    for (const b of (r.blobs || [])) await st.delete(b.key).catch(() => {});
  }
  await st.delete(`portada:${tel}`).catch(() => {});
}
const leerEstado = async (tel) => { try { return JSON.parse(await store().get(tel) || "null") || { paso: "MENU" }; } catch (e) { return { paso: "MENU" }; } };
const guardarEstado = (tel, st) => store().set(tel, JSON.stringify(st));
const borrarEstado = (tel) => store().delete(tel).catch(() => {});

/* ============ Órdenes abiertas del portal (misma lógica que odoo-sale-orders) ============ */
async function ordenesAbiertas() {
  const domain = ["&", "&", ["order_line.product_id.type", "=", "service"], ["state", "in", ["sale", "done"]],
    ...(DESDE ? [["date_order", ">=", DESDE + " 00:00:00"]] : [["id", ">", 0]])];
  const orders = await executeKw("sale.order", "search_read", [domain],
    { fields: ["id", "name", "partner_id", "date_order"], limit: 20, order: "date_order desc" });
  const ids = orders.map((o) => o.id);
  // Nota de servicio de cada orden (primera línea tipo "nota"), para que el
  // técnico sepa DE QUÉ es cada orden, igual que en el portal.
  const notaMap = {};
  if (ids.length) {
    const notas = await executeKw("sale.order.line", "search_read",
      [[["order_id", "in", ids], ["display_type", "=", "line_note"]]],
      { fields: ["order_id", "name", "sequence"], order: "sequence asc" }).catch(() => []);
    for (const n of notas) {
      const oid = Array.isArray(n.order_id) ? n.order_id[0] : n.order_id;
      if (notaMap[oid] === undefined) notaMap[oid] = (n.name || "").trim();
    }
  }
  const ocultas = {};
  if (ids.length) {
    const atts = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "in", ids], ["name", "=", ATT_NAME]]],
      { fields: ["res_id", "datas"] }).catch(() => []);
    for (const a of atts) {
      try {
        const r = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8"));
        if (r && ["submitted", "validated", "approved"].includes(r.status)) ocultas[a.res_id] = true;
      } catch (e) {}
    }
  }
  return orders.filter((o) => !ocultas[o.id]).slice(0, 10)
    .map((o) => ({ id: o.id, name: o.name, partner: Array.isArray(o.partner_id) ? o.partner_id[1] : "",
      nota: notaMap[o.id] || "", date: (o.date_order || "").slice(0, 10) }));
}

/* ============ Guardar/leer el reporte en la orden (mismo adjunto del portal) ============ */
async function guardarReporte(orderId, report) {
  const datas = Buffer.from(JSON.stringify(report), "utf8").toString("base64");
  const existing = await executeKw("ir.attachment", "search",
    [[["res_model", "=", "sale.order"], ["res_id", "=", orderId], ["name", "=", ATT_NAME]]], { limit: 1 });
  if (existing.length) await executeKw("ir.attachment", "write", [[existing[0]], { datas }]);
  else await executeKw("ir.attachment", "create", [{ name: ATT_NAME, res_model: "sale.order", res_id: orderId, type: "binary", mimetype: "application/json", datas }]);
}
async function leerReporte(orderId) {
  const found = await executeKw("ir.attachment", "search_read",
    [[["res_model", "=", "sale.order"], ["res_id", "=", orderId], ["name", "=", ATT_NAME]]],
    { fields: ["datas"], limit: 1 });
  if (!found.length) return null;
  try { return JSON.parse(Buffer.from(found[0].datas || "", "base64").toString("utf8")); } catch (e) { return null; }
}

/* ============ Textos del bot ============ */
const T = {
  menu: "¡Hola{n}! Soy el asistente de HydraTech. ¿Qué quieres hacer?",
  s1: "📋 *Paso 2 — CÓMO SE ENCONTRÓ (hallazgos)*\n\nMándame una *nota de voz* contando cómo encontraste el equipo: fallas, diagnóstico, lo que detectaste.\n\n📌 En esta sección son *obligatorias*: 1 nota de voz (o texto) y al menos 1 *foto*.\nCuando tengas ambas, escribe *LISTO*.",
  s2: "🔧 *Paso 3 — QUÉ SE HIZO (actividades)*\n\nAhora una *nota de voz* con el trabajo que realizaste: reparaciones, ajustes, cambios.\n\n📌 En esta sección son *obligatorias*: 1 nota de voz (o texto) y al menos 1 *foto* de la reparación.\nCuando tengas ambas, escribe *LISTO*.",
  s3: "📈 *Paso 4 — PLAN DE ACCIÓN*\n\nÚltima *nota de voz*: recomendaciones, pendientes, refacciones a cambiar y lo que el cliente pidió.\n\n📌 Obligatoria la nota de voz (o texto); las fotos aquí son *opcionales*.\nEscribe *LISTO* para generar el reporte.",
  voz: "🗣 *Voz del cliente*\n\n¿De qué *cliente* se trata? Escríbeme el nombre (o parte) y lo busco en el sistema.",
  vozAudio: "🎤 Ahora mándame la *nota de voz* con todo: lo que el cliente dijo, pidió o se quejó, y lo que tú viste o detectaste.\n\nPuedes mandar varias notas y *fotos*. Escribe *LISTO* cuando termines.",
};

async function mandarMenu(tel, nombre) {
  await enviarBotones(tel, T.menu.replace("{n}", nombre ? " " + nombre.split(" ")[0] : ""), [
    { id: "op_reporte", titulo: "1️⃣ Reporte servicio" },
    { id: "op_voz", titulo: "2️⃣ Voz del cliente" },
  ]);
}

/* ============ Resumen del reporte para validación ============ */
function resumenReporte(rep) {
  const li = (arr, f) => (arr || []).map((x) => "• " + f(x)).join("\n") || "• (vacío)";
  return `*${rep.folio || ""} · ${rep.cliente || ""}*\n🏷 ${rep.brand === "tubemac" ? "Tube-Mac" : "HydraTech"} · Técnico: ${(rep.tecnicos || []).join(", ") || "n/d"}\n\n*HALLAZGOS*\n${li(rep.content?.hallazgos, (h) => `${h.titulo} (${h.severidad || "normal"})`)}\n\n*ACTIVIDADES*\n${li(rep.content?.actividades, (a) => `${a.titulo} (${a.estado || ""})`)}\n\n*PLAN*\n${li(rep.content?.plan, (p) => `${p.titulo} — ${p.prioridad || ""}, ${p.urgencia || ""}`)}`;
}

/* ============ Handler principal ============ */
export default async (req) => {
  // Verificación del webhook (Meta manda GET al configurarlo)
  if (req.method === "GET") {
    const u = new URL(req.url);
    if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === VERIFY) {
      return new Response(u.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ ok: false }, 405);

  const body = await req.json().catch(() => ({}));
  const msg = leerMensaje(body);
  if (!msg) return json({ ok: true }); // estados de entrega, etc.

  try { await atender(msg); }
  catch (e) {
    console.error("Bot error:", e);
    await enviarTexto(msg.de, "⚠️ Algo falló: " + (e.message || e) + "\nEscribe *menu* para empezar de nuevo.").catch(() => {});
  }
  return json({ ok: true }); // siempre 200 para que Meta no reintente
};

async function atender(msg) {
  const tel = msg.de;
  const texto = (msg.texto || "").trim();
  const cmd = texto.toLowerCase();

  /* Deduplicar reintentos de Meta: cuando la respuesta tarda (p. ej. audios
     largos), Meta reenvía el MISMO mensaje y eso descarrilaba el flujo. */
  const st = await leerEstado(tel);
  if (msg.id && st.lastMsgId === msg.id) return;
  st.lastMsgId = msg.id;
  await guardarEstado(tel, st);

  /* ---- Botones de validación del ADMIN ---- */
  if (tel === ADMIN && msg.botonId && /^(ap|re)_\d+$/.test(msg.botonId)) {
    const [accion, idStr] = msg.botonId.split("_");
    const orderId = parseInt(idStr, 10);
    const rep = await leerReporte(orderId);
    if (!rep) { await enviarTexto(ADMIN, "No encontré el reporte de esa orden."); return; }
    if (accion === "ap") {
      rep.status = "validated"; rep.validatedAt = new Date().toISOString();
      // PLAN → CRM: una oportunidad con actividades, asignada al vendedor de la orden
      let leadTxt = "";
      try {
        const leadId = await crearOportunidadDePlan(orderId, rep);
        if (leadId) { rep.crmLeadId = leadId; leadTxt = `\n📈 El plan de acción ya está en el CRM (oportunidad #${leadId}).`; }
      } catch (e) { leadTxt = "\n⚠️ No pude crear la oportunidad del plan: " + (e.message || e); }
      await guardarReporte(orderId, rep);
      const link = `${SITE}/firma.html?id=${orderId}&t=${firmaToken(orderId)}`;
      await enviarTexto(ADMIN, `✅ Validado *${rep.folio || orderId}*. Le mandé al técnico el link de firma.${leadTxt}`);
      if (rep.waTecnico) await enviarTexto(rep.waTecnico,
        `✅ Tu reporte *${rep.folio || ""}* fue validado.\n\nAbre este link y dáselo al cliente para que *firme en tu teléfono* antes de irte:\n${link}`);
    } else {
      rep.status = "draft"; rep.rechazoAt = new Date().toISOString();
      await guardarReporte(orderId, rep);
      await enviarTexto(ADMIN, `↩️ Rechazado *${rep.folio || orderId}*. Quedó como borrador; el técnico puede corregirlo (mándame nota de qué corregir y yo se la paso, o edítalo en el portal).`);
      if (rep.waTecnico) await enviarTexto(rep.waTecnico, `↩️ Tu reporte *${rep.folio || ""}* fue regresado para corrección. Puedes rehacerlo escribiendo *menu* o esperar instrucciones.`);
    }
    return;
  }

  /* ---- Comandos globales ---- */
  if (["menu", "menú", "hola", "cancelar", "inicio"].includes(cmd)) {
    await borrarEstado(tel);
    await limpiarMedia(tel);
    await guardarEstado(tel, { paso: "MENU", lastMsgId: msg.id });
    await mandarMenu(tel, nombreTecnico(tel) || msg.nombre);
    return;
  }

  /* ---- Selección del menú ---- */
  if (msg.botonId === "op_reporte" || (st.paso === "MENU" && cmd === "1")) {
    const ords = await ordenesAbiertas();
    if (!ords.length) { await enviarTexto(tel, "No hay órdenes de servicio abiertas sin reporte. Escribe *menu* para volver."); return; }
    await guardarEstado(tel, { paso: "ORDEN", ordenes: ords, lastMsgId: msg.id });
    await enviarLista(tel, "¿De qué *orden de venta* es el reporte?", "Elegir orden",
      ords.map((o) => ({ id: "ord_" + o.id, titulo: o.name,
        desc: o.nota ? `${o.nota} · ${o.partner}` : `${o.partner} · ${o.date}` })));
    return;
  }
  if (msg.botonId === "op_voz" || (st.paso === "MENU" && cmd === "2")) {
    await limpiarMedia(tel);
    await guardarEstado(tel, { paso: "VOZ_BUSCA", lastMsgId: msg.id });
    await enviarTexto(tel, T.voz);
    return;
  }

  /* ---- Flujo: Reporte de servicio ---- */
  if (st.paso === "ORDEN" && msg.botonId && msg.botonId.startsWith("ord_")) {
    const id = parseInt(msg.botonId.slice(4), 10);
    const o = (st.ordenes || []).find((x) => x.id === id) || { id, name: "", partner: "" };
    await limpiarMedia(tel); // arrancar limpio: sin fotos/notas de intentos anteriores
    await guardarEstado(tel, { paso: "MARCA", orden: o, brand: "hydratech", lastMsgId: msg.id });
    await enviarBotones(tel, `Orden *${o.name}* — ${o.partner}${o.nota ? "\n📝 " + o.nota : ""}\n\n¿A nombre de qué *empresa* va el reporte?`, [
      { id: "br_hydratech", titulo: "HydraTech Group" },
      { id: "br_tubemac", titulo: "Tube-Mac" },
    ]);
    return;
  }

  if (st.paso === "MARCA") {
    if (msg.botonId === "br_hydratech" || msg.botonId === "br_tubemac" || ["hydratech", "tubemac", "tube-mac"].includes(cmd)) {
      st.brand = (msg.botonId === "br_tubemac" || /tube/.test(cmd)) ? "tubemac" : "hydratech";
      st.paso = "PORTADA"; await guardarEstado(tel, st);
      await enviarTexto(tel, `🏷 Reporte a nombre de *${st.brand === "tubemac" ? "Tube-Mac" : "HydraTech Group"}*.\n\n📷 *Paso 1 — Foto de portada*\n\nMándame la foto principal del trabajo (la que va en la portada del reporte), o escribe *OMITIR*.`);
      return;
    }
    await enviarTexto(tel, "Elige con los botones: *HydraTech Group* o *Tube-Mac*.");
    return;
  }

  if (st.paso === "PORTADA") {
    if (msg.tipo === "image" && msg.mediaId) {
      const m = await descargarMedia(msg.mediaId);
      await setPortada(tel, `data:${m.mime};base64,${m.base64}`);
      st.paso = "S1"; await guardarEstado(tel, st);
      await enviarTexto(tel, "📷 Portada guardada.\n\n" + T.s1);
      return;
    }
    if (cmd === "omitir" || cmd === "listo") {
      st.paso = "S1"; await guardarEstado(tel, st);
      await enviarTexto(tel, T.s1);
      return;
    }
    await enviarTexto(tel, "Mándame la *foto de portada* o escribe *OMITIR*.");
    return;
  }

  if (["S1", "S2", "S3"].includes(st.paso)) {
    const sec = { S1: "hallazgos", S2: "actividades", S3: "plan" }[st.paso];
    const campo = { S1: "h", S2: "a", S3: "p" }[st.paso];

    if (msg.tipo === "audio" && msg.mediaId) {
      await enviarTexto(tel, "🎧 Escuchando tu nota…");
      const m = await descargarMedia(msg.mediaId);
      const tx = await transcribirAudio(m.mime, m.base64);
      await agregarNota(tel, sec, tx, msg); // registro independiente: no se pisa con mensajes simultáneos
      await enviarTexto(tel, `✍️ Anoté en *${sec.toUpperCase()}*:\n_"${tx.slice(0, 400)}"_\n\nManda *fotos* u otro audio para agregar más, o escribe *LISTO* para continuar.`);
      return;
    }
    if (msg.tipo === "image" && msg.mediaId) {
      const total = await contar(`foto:${tel}:`);
      if (total >= 9) { await enviarTexto(tel, "Máximo 9 fotos por reporte. Escribe *LISTO* para continuar."); return; }
      const m = await descargarMedia(msg.mediaId);
      await agregarFoto(tel, sec, `data:${m.mime};base64,${m.base64}`, msg.caption || "", msg);
      await enviarTexto(tel, `📸 Foto guardada en *${sec.toUpperCase()}* (${total + 1} en total).`);
      return;
    }
    if (cmd === "listo" || cmd === "siguiente") {
      // Requisitos: HALLAZGOS y ACTIVIDADES llevan OBLIGATORIAMENTE nota (voz o texto) + al menos 1 foto.
      // PLAN DE ACCIÓN lleva nota obligatoria; las fotos ahí son opcionales.
      const fotosSec = await contar(`foto:${tel}:${sec}:`);
      const notasSec = await contar(`nota:${tel}:${sec}:`);
      if (st.paso === "S1" || st.paso === "S2") {
        const faltan = [];
        if (!notasSec) faltan.push("una *nota de voz* (o texto)");
        if (!fotosSec) faltan.push("al menos una *foto*");
        if (faltan.length) {
          await enviarTexto(tel, `⚠️ Para cerrar *${sec.toUpperCase()}* falta: ${faltan.join(" y ")}.\nEs obligatorio en esta sección — mándalo y luego escribe *LISTO*.`);
          return;
        }
      }
      if (st.paso === "S3" && !notasSec) {
        await enviarTexto(tel, "⚠️ Falta la *nota de voz* (o texto) del *PLAN DE ACCIÓN* antes de generar el reporte. Las fotos aquí son opcionales.");
        return;
      }
      if (st.paso === "S1") { st.paso = "S2"; await guardarEstado(tel, st); await enviarTexto(tel, T.s2); return; }
      if (st.paso === "S2") { st.paso = "S3"; await guardarEstado(tel, st); await enviarTexto(tel, T.s3); return; }
      // S3 -> generar
      await enviarTexto(tel, "🤖 Generando tu reporte con IA, dame unos segundos…");
      await generarYEnviar(tel, st);
      return;
    }
    if (texto) { // texto libre también suma a la sección
      await agregarNota(tel, sec, texto, msg);
      await enviarTexto(tel, `✍️ Anotado en *${sec.toUpperCase()}*. Escribe *LISTO* cuando termines esta sección.`);
      return;
    }
  }

  /* ---- Flujo: Voz del cliente 2.0 ---- */
  // Paso 1: buscar el cliente en Odoo y elegirlo de una lista
  if (st.paso === "VOZ_BUSCA" && texto && !msg.botonId) {
    const parts = await executeKw("res.partner", "search_read",
      [["&", ["parent_id", "=", false], ["name", "ilike", texto]]],
      { fields: ["id", "name", "city"], limit: 9 }).catch(() => []);
    const filas = parts.map((c) => ({ id: "pt_" + c.id, titulo: c.name, desc: c.city || "" }));
    filas.push({ id: "pt_otro", titulo: "➕ Otro / no está", desc: "Registrar con el nombre que escribiste" });
    st.busqueda = texto; st.clientes = parts.map((c) => ({ id: c.id, name: c.name }));
    await guardarEstado(tel, st);
    await enviarLista(tel, parts.length ? `Encontré esto para *"${texto}"*:` : `No encontré *"${texto}"* en el sistema.`, "Elegir cliente", filas);
    return;
  }
  if (st.paso === "VOZ_BUSCA" && msg.botonId && msg.botonId.startsWith("pt_")) {
    let cliente = null;
    if (msg.botonId !== "pt_otro") {
      const cid = parseInt(msg.botonId.slice(3), 10);
      cliente = (st.clientes || []).find((c) => c.id === cid) || { id: cid, name: msg.texto || "" };
    }
    await guardarEstado(tel, { paso: "VOZ_AUDIO", cliente, ref: cliente ? cliente.name : (st.busqueda || ""), tx: "", fotos: [], lastMsgId: msg.id });
    await enviarTexto(tel, `Cliente: *${cliente ? cliente.name : st.busqueda || "por identificar"}*.\n\n` + T.vozAudio);
    return;
  }

  // Paso 2: acumular audios y fotos
  if (st.paso === "VOZ_AUDIO") {
    if (msg.tipo === "audio" && msg.mediaId) {
      await enviarTexto(tel, "🎧 Escuchando…");
      const m = await descargarMedia(msg.mediaId);
      const tx = await transcribirAudio(m.mime, m.base64);
      await agregarNota(tel, "voz", tx, msg);
      await enviarTexto(tel, `✍️ Anoté:\n_"${tx.slice(0, 400)}"_\n\nManda otro audio, *fotos*, o escribe *LISTO*.`);
      return;
    }
    if (msg.tipo === "image" && msg.mediaId) {
      const total = await contar(`foto:${tel}:voz:`);
      if (total >= 6) { await enviarTexto(tel, "Máximo 6 fotos. Escribe *LISTO* para continuar."); return; }
      const m = await descargarMedia(msg.mediaId);
      await agregarFoto(tel, "voz", `data:${m.mime};base64,${m.base64}`, "", msg);
      await enviarTexto(tel, `📸 Foto guardada (${total + 1}).`);
      return;
    }
    if (cmd === "listo") {
      const med = await recolectar(tel);
      if (!med.notas.voz) { await enviarTexto(tel, "Aún no me mandas ninguna nota de voz. 🎤"); return; }
      st.tx = med.notas.voz; // para la transcripción completa al guardar
      await enviarTexto(tel, "🤖 Estructurando la información…");
      const v = await estructurarVozCliente(`Cliente: ${st.ref || "(no identificado)"}\n\n${med.notas.voz}`);
      st.voz = v; st.paso = "VOZ_CONF";
      await guardarEstado(tel, st);
      const li = (arr) => (arr || []).map((x) => "• " + (x.titulo ? `${x.titulo} (${x.prioridad || "media"})` : x)).join("\n") || "• (nada)";
      await enviarTexto(tel, `Esto entendí de *${st.ref || "la visita"}*:\n\n*El cliente dijo/pidió:*\n${li(v.comentarios_cliente)}\n\n*Quejas:*\n${li(v.quejas)}\n\n*Detectado por ti:*\n${li(v.detectado)}\n\n*Oportunidades:*\n${li(v.oportunidades)}`);
      await enviarBotones(tel, "¿Lo guardo así?", [
        { id: "vc_ok", titulo: "✅ Guardar" },
        { id: "vc_mas", titulo: "🎤 Agregar más" },
      ]);
      return;
    }
    if (texto) { st.tx = (st.tx ? st.tx + "\n" : "") + texto; await guardarEstado(tel, st); await enviarTexto(tel, "✍️ Anotado. Escribe *LISTO* cuando termines."); return; }
  }

  // Paso 3: confirmar y rutear
  if (st.paso === "VOZ_CONF") {
    if (msg.botonId === "vc_mas") { st.paso = "VOZ_AUDIO"; await guardarEstado(tel, st); await enviarTexto(tel, "Va, mándame más audios o fotos. Escribe *LISTO* al terminar."); return; }
    if (msg.botonId === "vc_ok") { await guardarVozCliente(tel, st, msg); return; }
  }

  /* ---- Cualquier otra cosa ---- */
  if (st.paso && st.paso !== "MENU") {
    // A MITAD DE UN FLUJO: nunca reiniciar. Recordar el paso y seguir.
    const pista = {
      ORDEN: "elige la orden en la lista que te mandé",
      MARCA: "elige la empresa con los botones (HydraTech o Tube-Mac)",
      PORTADA: "mándame la *foto de portada* o escribe *OMITIR*",
      S1: "vamos en *HALLAZGOS*: manda nota de voz, fotos, o escribe *LISTO*",
      S2: "vamos en *ACTIVIDADES*: manda nota de voz, fotos, o escribe *LISTO*",
      S3: "vamos en *PLAN DE ACCIÓN*: manda nota de voz, fotos, o escribe *LISTO*",
      VOZ_BUSCA: "escríbeme el *nombre del cliente* para buscarlo",
      VOZ_AUDIO: "mándame la *nota de voz*, fotos, o escribe *LISTO*",
      VOZ_CONF: "elige con los botones: ✅ Guardar o 🎤 Agregar más",
    }[st.paso] || "sigamos donde íbamos";
    await enviarTexto(tel, "🤖 Seguimos en el mismo trámite: " + pista + "\n\n(Solo entiendo notas de voz, fotos y texto. Para empezar de cero escribe *cancelar*)");
    return;
  }
  await mandarMenu(tel, nombreTecnico(tel) || msg.nombre);
  await guardarEstado(tel, { paso: "MENU", lastMsgId: msg.id });
}

/* ============ Voz del cliente: guardar y rutear ============ */
async function guardarVozCliente(tel, st, msg) {
  const v = st.voz || {};
  const tec = nombreTecnico(tel) || msg.nombre || tel;
  const partnerId = st.cliente ? st.cliente.id : null;
  const vendedor = partnerId ? await vendedorDe(partnerId) : null;
  const hayQuejas = (v.quejas || []).length > 0;

  // Prioridad del lead: alta si hay quejas u oportunidad alta
  const prioAlta = hayQuejas || (v.oportunidades || []).some((o) => o.prioridad === "alta");
  const prioMedia = (v.oportunidades || []).some((o) => o.prioridad === "media");
  const priority = prioAlta ? "2" : prioMedia ? "1" : "0";

  const ul = (arr, f) => (arr || []).length ? `<ul>${arr.map((x) => `<li>${f ? f(x) : x}</li>`).join("")}</ul>` : "";
  const desc = [
    `<p><b>Voz del cliente</b> capturada por WhatsApp — ${tec} (${new Date().toISOString().slice(0, 10)})</p>`,
    v.resumen ? `<p><b>Resumen:</b> ${v.resumen}</p>` : "",
    (v.comentarios_cliente || []).length ? `<p><b>El cliente dijo/pidió:</b></p>${ul(v.comentarios_cliente)}` : "",
    hayQuejas ? `<p><b>⚠️ QUEJAS:</b></p>${ul(v.quejas)}` : "",
    (v.detectado || []).length ? `<p><b>Detectado por el técnico:</b></p>${ul(v.detectado)}` : "",
    (v.oportunidades || []).length ? `<p><b>Oportunidades:</b></p>${ul(v.oportunidades, (o) => `[${o.prioridad || "media"}] ${o.titulo}: ${o.descripcion || ""}`)}` : "",
    `<p><i>Transcripción completa:</i><br>${(st.tx || "").replace(/\n/g, "<br>")}</p>`,
  ].filter(Boolean).join("");

  const lead = {
    name: (hayQuejas ? "⚠️ " : "") + `Voz del cliente: ${st.ref || v.cliente || "sin identificar"}`,
    type: "opportunity", description: desc, priority,
  };
  if (partnerId) lead.partner_id = partnerId;
  if (vendedor) lead.user_id = vendedor.id;
  const leadId = await executeKw("crm.lead", "create", [lead]);

  // Fotos adjuntas al lead (recolectadas de los registros independientes)
  const medFotos = (await recolectar(tel)).fotos.filter((f) => f.sec === "voz");
  for (const f of medFotos) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(f.dataURL || "");
    if (!m) continue;
    await executeKw("ir.attachment", "create", [{
      name: "voz-cliente.jpg", res_model: "crm.lead", res_id: leadId,
      type: "binary", mimetype: m[1] || "image/jpeg", datas: m[2],
    }]).catch(() => {});
  }

  // Cada pendiente (detectado + quejas) como ACTIVIDAD con fecha límite, para que no muera
  try {
    const modelIds = await executeKw("ir.model", "search", [[["model", "=", "crm.lead"]]], { limit: 1 });
    const tipoIds = await executeKw("mail.activity.type", "search",
      [["|", ["name", "ilike", "to-do"], ["name", "ilike", "por hacer"]]], { limit: 1 }).catch(() => []);
    const deadline = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const pendientes = [...(v.quejas || []).map((q) => "Atender queja: " + q), ...(v.detectado || [])];
    for (const p of pendientes.slice(0, 10)) {
      await executeKw("mail.activity", "create", [{
        res_model_id: modelIds[0], res_id: leadId,
        ...(tipoIds.length ? { activity_type_id: tipoIds[0] } : {}),
        summary: p.slice(0, 120), date_deadline: deadline,
        ...(vendedor ? { user_id: vendedor.id } : {}),
      }]).catch(() => {});
    }
  } catch (e) {}

  await borrarEstado(tel);
  await limpiarMedia(tel);
  await enviarTexto(tel, `✅ Guardado. Quedó en el CRM${vendedor ? ` asignado a *${vendedor.name}*` : ""}${hayQuejas ? " y ya se avisó de la queja" : ""}. ¡Nada se pierde! Escribe *menu* para otra cosa.`);

  // Avisos: admin SIEMPRE; vendedor por WhatsApp si está mapeado
  const aviso = `🗣 *Voz del cliente* — ${st.ref || v.cliente || "cliente por identificar"}\nCapturó: ${tec}\n${hayQuejas ? "⚠️ *HAY QUEJAS:*\n" + v.quejas.map((q) => "• " + q).join("\n") + "\n" : ""}${v.resumen || ""}\n→ Lead #${leadId} en el CRM${vendedor ? " (asignado a " + vendedor.name + ")" : ""}.`;
  if (ADMIN) enviarTexto(ADMIN, aviso).catch(() => {});
  const waVend = waDeVendedor(vendedor);
  if (waVend && waVend !== ADMIN) enviarTexto(waVend, aviso + "\n\nRevisa tu pipeline en Odoo para darle seguimiento. 🙌").catch(() => {});
}

/* ============ Generar reporte, guardar borrador y pedir validación al admin ============ */
async function generarYEnviar(tel, st) {
  const o = st.orden || {};
  const tec = nombreTecnico(tel) || "";
  // Recolectar TODO desde los registros independientes (a prueba de mensajes simultáneos)
  const med = await recolectar(tel);
  const fotosReporte = med.fotos.filter((f) => ["hallazgos", "actividades", "plan"].includes(f.sec));
  const contexto = `- Cliente: ${o.partner || "(de la orden)"}\n- Orden: ${o.name || ""}\n- Fecha: ${new Date().toISOString().slice(0, 10)}\n- Técnicos: ${tec || "(n/d)"}`;
  const notas = `[HALLAZGOS / cómo se encontró]\n${med.notas.h || "(sin notas)"}\n\n[ACTIVIDADES REALIZADAS]\n${med.notas.a || "(sin notas)"}\n\n[PLAN DE ACCIÓN / pendientes]\n${med.notas.p || "(sin notas)"}`;
  const content = await generarReporteIA({ contexto, notas, images: fotosReporte });

  const now = new Date().toISOString();
  const report = {
    status: "submitted", origen: "whatsapp", waTecnico: tel,
    brand: st.brand || "hydratech",
    cliente: o.partner || "", folio: o.name || "", fecha: now.slice(0, 10),
    planta: "", tipo: content.tipo_servicio || "",
    tecnicos: tec ? [tec] : [],
    notas: { hallazgos: med.notas.h, actividades: med.notas.a, plan: med.notas.p },
    content, images: fotosReporte, coverPhoto: med.portada || (fotosReporte[0] && fotosReporte[0].dataURL) || null,
    updatedAt: now, submittedAt: now,
  };
  await guardarReporte(o.id, report);
  await borrarEstado(tel);
  await limpiarMedia(tel);

  await enviarTexto(tel, `✅ *Reporte generado y enviado a validación.*\n\n${resumenReporte(report)}\n\nEn cuanto lo validen te llega aquí mismo el *link de firma* para el cliente.`);
  if (ADMIN) {
    const linkVer = `${SITE}/firma.html?id=${o.id}&t=${firmaToken(o.id)}`;
    await enviarTexto(ADMIN, `🔔 *Reporte nuevo por validar*\n\n${resumenReporte(report)}\n\n👁 Ver el reporte con diseño:\n${linkVer}`);
    await enviarBotones(ADMIN, `¿Validar el reporte de *${report.folio}*?`, [
      { id: "ap_" + o.id, titulo: "✅ Aprobar" },
      { id: "re_" + o.id, titulo: "↩️ Rechazar" },
    ]);
  }
}
