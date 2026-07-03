// netlify/functions/cobranza-listar.js
// GET /api/cobranza-listar?q=texto
// Lista las órdenes que YA ESTÁN EN COBRANZA y calcula el estado de cada una.
// Universo (igual que Reportes de venta): desde REPORTES_DESDE, con línea de servicio, no canceladas.
// Entran a cobranza SOLO las que tienen el reporte APROBADO (evidencia de entrega).
// El estado se DERIVA de los datos: SOLPED, OC, acuse, pago, complemento. Nada se elige a mano.
// El reloj de pago corre desde la fecha del acuse + días de crédito (Términos de pago de Odoo).
import { executeKw, checkToken, json } from "./lib/odoo.js";

const DESDE = process.env.REPORTES_DESDE || "";
const SERVICE_FIELD = process.env.SERVICE_TYPE_FIELD || "order_line.product_id.type";
const REP = "portal_reporte.json";
const COB = "portal_cobranza.json";
const ACUSE_PREFIX = "portal_acuse";
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

    // 1) Universo de órdenes (mismo filtro que Reportes de venta)
    const subs = [];
    if (DESDE) subs.push([["date_order", ">=", DESDE + " 00:00:00"]]);
    subs.push([[SERVICE_FIELD, "=", "service"]]);
    // Cobranza = post-venta: solo órdenes YA CONFIRMADAS como venta (no cotizaciones draft/sent, no canceladas).
    subs.push([["state", "in", ["sale", "done"]]]);
    if (q) subs.push(["|", ["name", "ilike", q], ["partner_id", "ilike", q]]);

    const orders = await executeKw("sale.order", "search_read", [AND(subs)],
      { fields: ["id", "name", "partner_id", "date_order", "amount_total", "state", "payment_term_id"], limit: 300, order: "date_order desc" });
    if (!orders.length) return json({ ok: true, desde: DESDE || null, ventas: [] });

    const ids = orders.map((o) => o.id);

    // 2) Adjuntos de todas las órdenes en una sola consulta
    const atts = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "in", ids],
        "|", "|", ["name", "=", REP], ["name", "=", COB], ["name", "like", ACUSE_PREFIX + "%"]]],
      { fields: ["res_id", "name", "datas"] }).catch(() => []);
    const repByOrder = {}, cobByOrder = {}, acuseByOrder = {};
    for (const a of atts) {
      if (a.name === REP) { try { repByOrder[a.res_id] = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {} }
      else if (a.name === COB) { try { cobByOrder[a.res_id] = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {} }
      else if ((a.name || "").indexOf(ACUSE_PREFIX) === 0) acuseByOrder[a.res_id] = true;
    }

    // 3) Días de crédito por término de pago (Términos de pago de Odoo)
    const termIds = [...new Set(orders.map((o) => Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null).filter(Boolean))];
    const daysByTerm = {};
    if (termIds.length) {
      const lines = await executeKw("account.payment.term.line", "search_read",
        [[["payment_id", "in", termIds]]], { fields: ["payment_id", "nb_days", "days"] }).catch(() => []);
      for (const l of lines) {
        const tid = Array.isArray(l.payment_id) ? l.payment_id[0] : l.payment_id;
        const d = Number(l.nb_days != null ? l.nb_days : (l.days != null ? l.days : 0)) || 0;
        daysByTerm[tid] = Math.max(daysByTerm[tid] || 0, d);
      }
    }

    // 4) Construir cada venta. Entra TODA orden de venta confirmada (servicio o material):
    // ya siendo orden de venta, es algo entregado/hecho y por tanto cobrable.
    const ventas = [];
    for (const o of orders) {
      const rep = repByOrder[o.id];
      const reporteAprobado = !!(rep && rep.status === "approved"); // informativo (solo servicios)

      const cob = cobByOrder[o.id] || {};
      const solped = (cob.solped || "").trim();
      const oc = (cob.oc || "").trim();
      const acuseAdjunto = !!acuseByOrder[o.id];
      const acuseFecha = cob.acuseFecha || "";
      const pago = cob.pago || null;
      const pagado = !!(pago && pago.complemento);

      // referencia de entrega para la antigüedad general
      const entregaRef = (rep && rep.approvedAt) || o.date_order || "";
      const edad = daysSince(entregaRef, now) || 0;

      // paso actual = primer paso incompleto
      let paso;
      if (!solped) paso = 1;                          // SOLPED
      else if (!oc) paso = 2;                          // Esperando OC (crítico, 10 días)
      else if (!acuseAdjunto) paso = 3;               // OC en proceso
      else if (!pagado) paso = 4;                     // Acuse subido → reloj de pago
      else paso = 5;                                  // Pagado

      // días en el paso actual + fecha de pago + foco rojo
      const termId = Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null;
      const plazoDias = termId != null && daysByTerm[termId] != null ? daysByTerm[termId] : null;
      let dias, fechaPago = "", diasParaPago = null, focoRojo = false;

      if (paso === 4) {
        dias = acuseFecha ? (daysSince(acuseFecha, now) || 0) : edad;
        if (acuseFecha && plazoDias != null) {
          fechaPago = addDays(acuseFecha, plazoDias);
          const fp = parseDate(fechaPago);
          diasParaPago = fp != null ? Math.round((fp - now) / DAY) : null;
          // foco rojo si ya venció y aún no hay pago registrado
          if (!pago && diasParaPago != null && diasParaPago < 0) focoRojo = true;
        }
      } else if (paso === 5) {
        dias = 0;
      } else {
        dias = edad; // aproximación: días desde la entrega
        if (paso === 2 && dias > OC_MAX) focoRojo = true; // regla de los 10 días
      }

      ventas.push({
        id: o.id,
        folio: o.name,
        cliente: Array.isArray(o.partner_id) ? o.partner_id[1] : "",
        monto: o.amount_total || 0,
        solped, oc,
        evidencia: reporteAprobado,
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
