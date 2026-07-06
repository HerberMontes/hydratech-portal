// netlify/functions/cobranza-listar.js
// GET /api/cobranza-listar?q=texto
// Lista las órdenes que YA ESTÁN EN COBRANZA y calcula el estado de cada una.
// Universo (igual que Reportes de venta): desde REPORTES_DESDE, con línea de servicio, no canceladas.
// Entran a cobranza SOLO las que tienen el reporte APROBADO (evidencia de entrega).
// El estado se DERIVA de los datos: SOLPED, OC, acuse, pago, complemento. Nada se elige a mano.
// El reloj de pago corre desde la fecha del acuse + días de crédito (Términos de pago de Odoo).
import { executeKw, checkToken, json } from "./lib/odoo.js";

const DESDE = process.env.REPORTES_DESDE || "";
// Órdenes atrasadas (anteriores al corte) que se incluyen por única vez.
// En Netlify: COBRANZA_EXTRA = "S00841,S00902,S00915"
const EXTRA = (process.env.COBRANZA_EXTRA || "").split(",").map((s) => s.trim()).filter(Boolean);
const SERVICE_FIELD = process.env.SERVICE_TYPE_FIELD || "order_line.product_id.type";
const REP = "portal_reporte.json";
const COB = "portal_cobranza.json";
const ACUSE_PREFIX = "portal_acuse";
const EVID_PREFIX = "portal_evidencia";
const DAY = 24 * 60 * 60 * 1000;

// Umbral del paso "Esperando OC" (regla del negocio: máximo 10 días).
const OC_MAX = 10;

function AND(subs) {
  subs = subs.filter((s) => s && s.length);
  if (!subs.length) return [];
  let d = [];
  for (let i = 0; i < subs.length - 1; i++) d.push("&");
  for (const s of subs) d = d.concat(s);
  return d;
}
function parseDate(s) { if (!s) return null; const t = Date.parse(String(s).replace(" ", "T") + (String(s).length <= 10 ? "T00:00:00Z" : "Z")); return isNaN(t) ? null : t; }
function daysSince(s, now) { const t = parseDate(s); return t == null ? null : Math.max(0, Math.round((now - t) / DAY)); }
function addDays(s, n) { const t = parseDate(s); if (t == null) return ""; return new Date(t + n * DAY).toISOString().slice(0, 10); }

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const now = Date.now();

    // 1) Universo de órdenes
    const subs = [];
    // (desde el corte REPORTES_DESDE) O (órdenes atrasadas específicas de COBRANZA_EXTRA)
    if (DESDE && EXTRA.length) subs.push(["|", ["date_order", ">=", DESDE + " 00:00:00"], ["name", "in", EXTRA]]);
    else if (DESDE) subs.push([["date_order", ">=", DESDE + " 00:00:00"]]);
    else if (EXTRA.length) subs.push([["name", "in", EXTRA]]);
    // Cobranza = post-venta: solo órdenes CONFIRMADAS (no cotizaciones, no canceladas).
    // Entra TODA orden de venta, sea servicio o material.
    subs.push([["state", "in", ["sale", "done"]]]);
    if (q) subs.push(["|", ["name", "ilike", q], ["partner_id", "ilike", q]]);

    const orders = await executeKw("sale.order", "search_read", [AND(subs)],
      { fields: ["id", "name", "partner_id", "date_order", "amount_total", "state", "payment_term_id", "invoice_ids"], limit: 300, order: "date_order desc" });
    if (!orders.length) return json({ ok: true, desde: DESDE || null, ventas: [] });

    const ids = orders.map((o) => o.id);

    // MONTO REAL: cobranza cobra FACTURAS, no cotizaciones. Si la orden ya
    // tiene factura(s) timbradas, el monto que se muestra y se suma es el
    // facturado (con notas de crédito restadas). Si no hay factura, se usa el
    // total de la orden. Esto corrige órdenes viejas cuyo total se movió
    // (p. ej. S01526/S01527) sin afectar el flujo de las nuevas.
    const facturaIds = [...new Set(orders.flatMap((o) => Array.isArray(o.invoice_ids) ? o.invoice_ids : []))];
    const facturadoPorOrden = {};
    if (facturaIds.length) {
      const moves = await executeKw("account.move", "search_read",
        [[["id", "in", facturaIds], ["state", "=", "posted"],
          ["move_type", "in", ["out_invoice", "out_refund"]]]],
        { fields: ["id", "amount_total", "move_type"], limit: 1000 }).catch(() => []);
      const montoMove = {};
      moves.forEach((m) => { montoMove[m.id] = (m.move_type === "out_refund" ? -1 : 1) * (m.amount_total || 0); });
      orders.forEach((o) => {
        const tot = (Array.isArray(o.invoice_ids) ? o.invoice_ids : [])
          .reduce((a, mid) => a + (montoMove[mid] || 0), 0);
        if (tot > 0) facturadoPorOrden[o.id] = tot;
      });
    }

    // 2) Adjuntos de todas las órdenes en una sola consulta
    const atts = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "in", ids],
        "|", "|", "|", ["name", "=", REP], ["name", "=", COB], ["name", "like", ACUSE_PREFIX + "%"], ["name", "like", EVID_PREFIX + "%"]]],
      { fields: ["res_id", "name", "datas"] }).catch(() => []);
    const repByOrder = {}, cobByOrder = {}, acuseByOrder = {}, evidByOrder = {};
    for (const a of atts) {
      if (a.name === REP) { try { repByOrder[a.res_id] = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {} }
      else if (a.name === COB) { try { cobByOrder[a.res_id] = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {} }
      else if ((a.name || "").indexOf(EVID_PREFIX) === 0) evidByOrder[a.res_id] = true;
      else if ((a.name || "").indexOf(ACUSE_PREFIX) === 0) acuseByOrder[a.res_id] = true;
    }

    // 3) Días de crédito por término de pago (Términos de pago de Odoo)
    const termIds = [...new Set(orders.map((o) => Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null).filter(Boolean))];
    const daysByTerm = {};
    if (termIds.length) {
      // nb_days (Odoo 17+) o days (Odoo 16-): pedir ambos a la vez truena la
      // consulta completa; se intenta uno y luego el otro.
      let lines = await executeKw("account.payment.term.line", "search_read",
        [[["payment_id", "in", termIds]]], { fields: ["payment_id", "nb_days"], limit: 500 }).catch(() => null);
      if (!lines) lines = await executeKw("account.payment.term.line", "search_read",
        [[["payment_id", "in", termIds]]], { fields: ["payment_id", "days"], limit: 500 }).catch(() => null);
      for (const l of (lines || [])) {
        const tid = Array.isArray(l.payment_id) ? l.payment_id[0] : l.payment_id;
        const d = Number(l.nb_days != null ? l.nb_days : l.days) || 0;
        daysByTerm[tid] = Math.max(daysByTerm[tid] || 0, d);
      }
    }

    // Umbrales rojos por paso
    const SOLPED_MAX = 3, OC_MAX2 = 10, ACUSE_MAX = 5;

    // 4) Construir cada venta. Entra TODA orden de venta confirmada (servicio o material).
    const ventas = [];
    for (const o of orders) {
      const rep = repByOrder[o.id];
      const reporteAprobado = !!(rep && rep.status === "approved");
      const evidenciaAdjunta = !!evidByOrder[o.id];
      const tieneEvidencia = reporteAprobado || evidenciaAdjunta; // servicio (reporte) o material (remisión)

      const cob = cobByOrder[o.id] || {};
      const solped = (cob.solped || "").trim();
      const oc = (cob.oc || "").trim();
      const acuseAdjunto = !!acuseByOrder[o.id];
      const acuseFecha = cob.acuseFecha || "";
      const pago = cob.pago || null;
      const pagado = !!(pago && pago.complemento);

      // fechas de referencia de cada paso (para relojes exactos)
      const evidenciaFecha = cob.evidenciaFecha || (rep && rep.approvedAt) || "";
      const solpedFecha = cob.solpedFecha || "";
      const ocFecha = cob.ocFecha || "";
      const edad = daysSince(evidenciaFecha || o.date_order, now) || 0;

      // paso actual (flujo de 5 pasos, sin OC en proceso)
      // 0 Evidencia · 1 SOLPED · 2 Esperando OC · 3 Acuse subido · 4 Pagado
      // El paso se toma del dato MÁS AVANZADO que exista: si ya hay SOLPED, OC
      // o pago, la evidencia quedó atrás por lógica (no hay OC sin haber
      // entregado). Esto aplica sobre todo a las órdenes atrasadas migradas,
      // que traen solped/OC pero no tienen reporte/remisión en el portal.
      let paso;
      if (pagado) paso = 4;
      else if (oc) paso = 3;
      else if (solped) paso = 2;
      else if (tieneEvidencia) paso = 1;
      else paso = 0;

      const termId = Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null;
      // Sin términos de pago en la orden: crédito por defecto (COBRANZA_CREDITO_DIAS, 30)
      const plazoDias = termId != null && daysByTerm[termId] != null ? daysByTerm[termId]
        : (parseInt(process.env.COBRANZA_CREDITO_DIAS || "30", 10) || 30);
      let dias = 0, fechaPago = "", diasParaPago = null, focoRojo = false;

      if (paso === 0) {
        dias = daysSince(o.date_order, now) || 0; // esperando evidencia
      } else if (paso === 1) {
        dias = daysSince(evidenciaFecha, now) || 0;
        if (dias > SOLPED_MAX) focoRojo = true;
      } else if (paso === 2) {
        dias = daysSince(solpedFecha, now) || 0;
        if (dias > OC_MAX2) focoRojo = true;
      } else if (paso === 3) {
        if (!acuseAdjunto) {
          // esperando que ingresen la factura (subir acuse) — máx 5 días desde la OC
          dias = daysSince(ocFecha, now) || 0;
          if (dias > ACUSE_MAX) focoRojo = true;
        } else {
          // acuse subido → corren los días de crédito hacia el pago
          dias = acuseFecha ? (daysSince(acuseFecha, now) || 0) : 0;
          if (acuseFecha && plazoDias != null) {
            fechaPago = addDays(acuseFecha, plazoDias);
            const fp = parseDate(fechaPago);
            diasParaPago = fp != null ? Math.round((fp - now) / DAY) : null;
            if (!pago && diasParaPago != null && diasParaPago < 0) focoRojo = true;
          }
        }
      } else {
        dias = 0; // pagado
      }

      ventas.push({
        id: o.id,
        folio: o.name,
        cliente: Array.isArray(o.partner_id) ? o.partner_id[1] : "",
        monto: facturadoPorOrden[o.id] != null ? facturadoPorOrden[o.id] : (o.amount_total || 0),
        montoDeFactura: facturadoPorOrden[o.id] != null,
        montoOrden: o.amount_total || 0,
        solped, oc,
        evidencia: tieneEvidencia,
        reporteAprobado, evidenciaAdjunta,
        acuse: acuseAdjunto,
        acuseFecha,
        pago,
        paso, dias, edad,
        plazoDias, fechaPago, diasParaPago,
        terminos: Array.isArray(o.payment_term_id) ? o.payment_term_id[1] : "",
        focoRojo,
        archivada: !!cob.archivada,
      });
    }

    // orden: foco rojo primero, luego más días atorado
    ventas.sort((a, b) => (b.focoRojo - a.focoRojo) || (b.dias - a.dias));

    return json({ ok: true, desde: DESDE || null, count: ventas.length, ventas });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
