// netlify/functions/score-pagador.js
// SCORE DE COMPORTAMIENTO DE PAGO por cliente (empresa madre).
// Métricas desde el historial REAL capturado en el portal de cobranza:
//   DÍAS A OC   = fecha OC recibida  − fecha de entrega (evidencia)
//   DÍAS DE PAGO = fecha de pago − (fecha de acuse + término de crédito)
//   GET /api/score-pagador          -> página visual (diseño de Claude Design)
//   GET /api/score-pagador?json=1   -> JSON {porPartner:{pid:score}} para los chips del portal
import { executeKw, checkToken, json } from "./lib/odoo.js";

const TPL = "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<script src=\"/support.js\"></script>\n</head>\n<body>\n<x-dc>\n<helmet>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<style>\n  body { margin: 0; background: #f4f5f9; font-family: 'IBM Plex Sans', sans-serif; color: #1b2138; }\n  a { color: #3a52a8; text-decoration: none; }\n  a:hover { color: #1b2138; }\n</style>\n</helmet>\n<div style=\"max-width: 1360px; margin: 0 auto; padding: 48px 40px 64px;\">\n  <div style=\"display: flex; flex-direction: column; gap: 6px; margin-bottom: 36px;\">\n    <div style=\"font-family: 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: 0.12em; color: #3a52a8; font-weight: 600;\">HYDRATECH GROUP \u00b7 PORTAL DE COBRANZA</div>\n    <h1 style=\"font-family: Archivo, sans-serif; font-size: 30px; font-weight: 700; margin: 0; letter-spacing: -0.01em;\">Comportamiento de pago por cliente</h1>\n    <p style=\"margin: 0; color: #46506a; font-size: 15px; max-width: 640px;\">D\u00edas a orden de compra + desviaci\u00f3n de pago contra t\u00e9rmino pactado. Dos tama\u00f1os: chip para la lista de cobranza y ficha para el detalle del cliente.</p>\n  </div>\n\n  <div style=\"display: flex; flex-direction: column; gap: 12px; margin-bottom: 40px;\">\n    <div style=\"font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.14em; color: #46506a; font-weight: 500;\">1 \u00b7 CHIP COMPACTO \u2014 LISTA DE COBRANZA</div>\n    <div style=\"display: flex; gap: 12px; flex-wrap: wrap; align-items: center;\">\n      <sc-for list=\"{{ clientes }}\" as=\"c\" hint-placeholder-count=\"3\">\n        <div style=\"display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px 0 4px; background: #ffffff; border: 1px solid #e6e9f0; border-radius: 13px;\">\n          <span style=\"width: 19px; height: 19px; border-radius: 50%; background: {{ c.color }}; color: #ffffff; font-family: Archivo, sans-serif; font-weight: 700; font-size: 12px; display: inline-flex; align-items: center; justify-content: center;\">{{ c.letra }}</span>\n          <span style=\"font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 500; color: #1b2138;\">OC {{ c.oc }}d \u00b7 Pago {{ c.pagoTxt }}d</span>\n        </div>\n      </sc-for>\n    </div>\n  </div>\n\n  <div style=\"display: flex; flex-direction: column; gap: 12px;\">\n    <div style=\"font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.14em; color: #46506a; font-weight: 500;\">2 \u00b7 FICHA EXPANDIDA \u2014 DETALLE DEL CLIENTE</div>\n    <div style=\"display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start;\">\n      <sc-for list=\"{{ clientes }}\" as=\"c\" hint-placeholder-count=\"3\">\n        <div style=\"width: 400px; background: #ffffff; border: 1px solid #e6e9f0; border-radius: 14px; padding: 24px; box-sizing: border-box; display: flex; flex-direction: column; gap: 18px;\">\n          <div style=\"display: flex; align-items: center; justify-content: space-between; gap: 16px;\">\n            <div style=\"display: flex; flex-direction: column; gap: 3px;\">\n              <div style=\"font-family: Archivo, sans-serif; font-size: 20px; font-weight: 600; letter-spacing: -0.01em;\">{{ c.nombre }}</div>\n              <div style=\"font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.1em; color: #46506a;\">CALIFICACI\u00d3N GLOBAL</div>\n            </div>\n            <div style=\"width: 64px; height: 64px; border-radius: 50%; background: {{ c.bg }}; border: 2px solid {{ c.color }}; color: {{ c.color }}; font-family: Archivo, sans-serif; font-weight: 700; font-size: 44px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;\">{{ c.letra }}</div>\n          </div>\n\n          <div style=\"display: flex; flex-direction: column; gap: 8px;\">\n            <div style=\"display: flex; align-items: baseline; justify-content: space-between; gap: 12px;\">\n              <span style=\"font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.1em; color: #46506a;\">D\u00cdAS A OC</span>\n              <span style=\"font-family: Archivo, sans-serif; font-size: 26px; font-weight: 700; color: {{ c.ocColor }};\">{{ c.oc }}<span style=\"font-size: 14px; font-weight: 500; color: #46506a;\"> d\u00edas</span></span>\n            </div>\n            <div style=\"position: relative; height: 6px; border-radius: 3px; background: linear-gradient(to right, #16a34a 0%, #16a34a 33.3%, #e8a317 33.3%, #e8a317 66.6%, #dc2626 66.6%, #dc2626 100%); opacity: 0.9;\">\n              <span style=\"position: absolute; top: -3px; left: {{ c.ocPct }}%; width: 4px; height: 12px; margin-left: -2px; background: #1b2138; border-radius: 2px; box-shadow: 0 0 0 2px #ffffff;\"></span>\n            </div>\n            <sc-if value=\"{{ mostrarUmbrales }}\" hint-placeholder-val=\"{{ true }}\">\n              <div style=\"display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: #9aa2b8;\"><span>0</span><span>10</span><span>20</span><span>30+</span></div>\n            </sc-if>\n          </div>\n\n          <div style=\"display: flex; flex-direction: column; gap: 8px;\">\n            <div style=\"display: flex; align-items: baseline; justify-content: space-between; gap: 12px;\">\n              <span style=\"font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.1em; color: #46506a;\">D\u00cdAS DE PAGO vs T\u00c9RMINO</span>\n              <span style=\"font-family: Archivo, sans-serif; font-size: 26px; font-weight: 700; color: {{ c.pagoColor }};\">{{ c.pagoTxt }}<span style=\"font-size: 14px; font-weight: 500; color: #46506a;\"> d\u00edas</span></span>\n            </div>\n            <div style=\"position: relative; height: 6px; border-radius: 3px; background: linear-gradient(to right, #16a34a 0%, #16a34a 33.3%, #e8a317 33.3%, #e8a317 66.6%, #dc2626 66.6%, #dc2626 100%); opacity: 0.9;\">\n              <span style=\"position: absolute; top: -3px; left: {{ c.pagoPct }}%; width: 4px; height: 12px; margin-left: -2px; background: #1b2138; border-radius: 2px; box-shadow: 0 0 0 2px #ffffff;\"></span>\n            </div>\n            <sc-if value=\"{{ mostrarUmbrales }}\" hint-placeholder-val=\"{{ true }}\">\n              <div style=\"display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: #9aa2b8;\"><span>\u22125</span><span>+5</span><span>+15</span><span>+25</span></div>\n            </sc-if>\n          </div>\n\n          <div style=\"font-size: 13px; color: #46506a;\">T\u00e9rmino pactado: {{ c.termino }} d\u00edas \u00b7 {{ c.operaciones }} operaciones analizadas</div>\n\n          <div style=\"background: {{ c.bg }}; border-radius: 10px; padding: 12px 14px; font-style: italic; font-size: 13.5px; line-height: 1.5; color: {{ c.veredictoColor }};\">{{ c.veredicto }}</div>\n\n          <div style=\"font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #9aa2b8;\">Actualizado {{ fecha }} \u00b7 basado en historial real de operaciones</div>\n        </div>\n      </sc-for>\n    </div>\n  </div>\n</div>\n</x-dc>\n<script type=\"text/x-dc\" data-dc-script data-props=\"{\n  &quot;mostrarUmbrales&quot;: { &quot;editor&quot;: &quot;boolean&quot;, &quot;default&quot;: true, &quot;tsType&quot;: &quot;boolean&quot;, &quot;section&quot;: &quot;Ficha&quot; },\n  &quot;fecha&quot;: { &quot;editor&quot;: &quot;text&quot;, &quot;default&quot;: &quot;17 jul 2026&quot;, &quot;tsType&quot;: &quot;string&quot;, &quot;section&quot;: &quot;Ficha&quot; }\n}\">\n// \u2500\u2500 DATOS DE EJEMPLO \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n// El backend alimenta este arreglo. Campos por cliente:\n//   nombre       string\n//   oc           d\u00edas promedio entre entrega y recepci\u00f3n de OC\n//   pago         d\u00edas promedio de desviaci\u00f3n vs t\u00e9rmino (+tarde, \u2212adelantado)\n//   termino      t\u00e9rmino de cr\u00e9dito pactado (d\u00edas)\n//   operaciones  n\u00famero de operaciones analizadas\nconst CLIENTES = [\n  { nombre: 'Metalsa',        oc: 6,  pago: 0,   termino: 30, operaciones: 48 },\n  { nombre: 'Frisa Forjados', oc: 14, pago: 12,  termino: 45, operaciones: 23 },\n  { nombre: 'Cuprum',         oc: 26, pago: 21,  termino: 30, operaciones: 17 },\n];\n\nconst COLORES = {\n  verde: { color: '#16a34a', bg: '#e8f4ec', texto: '#0f6e33' },\n  ambar: { color: '#e8a317', bg: '#fdf3e3', texto: '#8a5f0a' },\n  rojo:  { color: '#dc2626', bg: '#fdeaea', texto: '#a31313' },\n};\n\n// Sem\u00e1foros exactos (null = sin historial suficiente -> \u00e1mbar neutro)\nfunction nivelOC(d)   { if (d == null) return 'ambar'; return d <= 10 ? 'verde' : d <= 20 ? 'ambar' : 'rojo'; }\nfunction nivelPago(d) { if (d == null) return 'ambar'; return d <= 5  ? 'verde' : d <= 15 ? 'ambar' : 'rojo'; }\n\nfunction veredicto(c, letra) {\n  if (c.oc == null && c.pago == null) return 'Sin historial suficiente: captura entregas, OC y pagos en el portal para calificar a este cliente.';\n  if (c.oc == null) return 'Paga a ' + (c.pago > 0 ? '+' + c.pago : c.pago) + ' d\u00edas de su t\u00e9rmino. Falta historial de OC (captura fechas de entrega y OC en el portal).';\n  if (c.pago == null) return 'Emite OC en ' + c.oc + ' d\u00edas. Falta historial de pagos capturados para calificar su puntualidad.';\n  const pagoTxt = c.pago > 0 ? '+' + c.pago : String(c.pago);\n  if (letra === 'A') {\n    const pago = c.pago <= 0 && c.pago >= -1 ? 'pago puntual' : (c.pago < 0 ? 'paga ' + Math.abs(c.pago) + ' d\u00edas antes de vencer' : 'pago casi puntual');\n    return 'Cliente ejemplar: OC en ' + c.oc + ' d\u00edas y ' + pago + ' \u2014 candidato a m\u00e1s l\u00ednea de cr\u00e9dito.';\n  }\n  if (letra === 'C') {\n    return 'Paga a ' + pagoTxt + ' d\u00edas de su t\u00e9rmino y tarda ' + c.oc + ' en emitir OC \u2014 considerar anticipo o apretar cr\u00e9dito.';\n  }\n  return 'OC en ' + c.oc + ' d\u00edas y paga a ' + pagoTxt + ' de su t\u00e9rmino \u2014 vigilar tendencia y facturar en cuanto llegue la OC.';\n}\n\n// Calcula todo lo derivado de un cliente crudo (el \"render\" que consume el backend)\nfunction render(c) {\n  const nOC = nivelOC(c.oc), nP = nivelPago(c.pago);\n  const letra = (nOC === 'verde' && nP === 'verde') ? 'A' : (nOC === 'rojo' || nP === 'rojo') ? 'C' : 'B';\n  const g = COLORES[letra === 'A' ? 'verde' : letra === 'B' ? 'ambar' : 'rojo'];\n  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));\n  return {\n    ...c,\n    letra,\n    color: g.color, bg: g.bg, veredictoColor: g.texto,\n    ocColor: COLORES[nOC].color,\n    pagoColor: COLORES[nP].color,\n    oc: c.oc == null ? 's/d' : c.oc,\n    pagoTxt: c.pago == null ? 's/d' : (c.pago > 0 ? '+' + c.pago : String(c.pago)),\n    ocPct: (clamp(c.oc == null ? 0 : c.oc, 0, 30) / 30 * 100).toFixed(1),\n    pagoPct: ((clamp(c.pago == null ? 0 : c.pago, -5, 25) + 5) / 30 * 100).toFixed(1),\n    veredicto: veredicto(c, letra),\n  };\n}\n\nclass Component extends DCLogic {\n  renderVals() {\n    return {\n      clientes: CLIENTES.map(render),\n      fecha: this.props.fecha ?? '17 jul 2026',\n      mostrarUmbrales: this.props.mostrarUmbrales ?? true,\n    };\n  }\n}\n</script>\n</body>\n</html>\n";
const CLIENTES_BLOCK = "const CLIENTES = [\n  { nombre: 'Metalsa',        oc: 6,  pago: 0,   termino: 30, operaciones: 48 },\n  { nombre: 'Frisa Forjados', oc: 14, pago: 12,  termino: 45, operaciones: 23 },\n  { nombre: 'Cuprum',         oc: 26, pago: 21,  termino: 30, operaciones: 17 },\n];";
const COB = "portal_cobranza.json";
const DAY = 86400000;
const CREDITO_DEFAULT = parseInt(process.env.COBRANZA_CREDITO_DIAS || "30", 10) || 30;
const pd = (s) => { if (!s) return null; const t = Date.parse(String(s).slice(0, 10) + "T00:00:00Z"); return isNaN(t) ? null : t; };

export async function calcularScores() {
  const orders = await executeKw("sale.order", "search_read",
    [[["state", "in", ["sale", "done"]]]],
    { fields: ["id", "name", "partner_id", "payment_term_id"], limit: 800, order: "date_order desc" });
  if (!orders.length) return { lista: [], porPartner: {} };
  const ids = orders.map((o) => o.id);

  const atts = await executeKw("ir.attachment", "search_read",
    [[["res_model", "=", "sale.order"], ["res_id", "in", ids], ["name", "=", COB]]],
    { fields: ["res_id", "datas"], limit: 1000 });
  const cobBy = {};
  for (const a of atts) { try { cobBy[a.res_id] = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {} }

  const termIds = [...new Set(orders.map((o) => Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null).filter(Boolean))];
  const daysByTerm = {};
  if (termIds.length) {
    let lines = await executeKw("account.payment.term.line", "search_read", [[["payment_id", "in", termIds]]], { fields: ["payment_id", "nb_days"], limit: 500 }).catch(() => null);
    if (!lines) lines = await executeKw("account.payment.term.line", "search_read", [[["payment_id", "in", termIds]]], { fields: ["payment_id", "days"], limit: 500 }).catch(() => null);
    for (const l of (lines || [])) { const tid = Array.isArray(l.payment_id) ? l.payment_id[0] : l.payment_id; const d = Number(l.nb_days != null ? l.nb_days : l.days) || 0; daysByTerm[tid] = Math.max(daysByTerm[tid] || 0, d); }
  }

  // Empresa madre (socio comercial) de cada contacto
  const pids = [...new Set(orders.map((o) => Array.isArray(o.partner_id) ? o.partner_id[0] : 0).filter(Boolean))];
  const partners = await executeKw("res.partner", "read", [pids, ["name", "commercial_partner_id"]]).catch(() => []);
  const madreDe = {}, nombreMadre = {};
  for (const p of partners) {
    const m = Array.isArray(p.commercial_partner_id) ? p.commercial_partner_id : [p.id, p.name];
    madreDe[p.id] = m[0]; nombreMadre[m[0]] = m[1];
  }

  const acc = {}; // madreId -> { ocSum, ocN, pagoSum, pagoN, plazos:{}, ops:Set, hijos:Set }
  for (const o of orders) {
    const cob = cobBy[o.id]; if (!cob) continue;
    const pid = Array.isArray(o.partner_id) ? o.partner_id[0] : 0;
    const madre = madreDe[pid] || pid; if (!madre) continue;
    const a = (acc[madre] = acc[madre] || { ocSum: 0, ocN: 0, pagoSum: 0, pagoN: 0, plazos: {}, ops: new Set(), hijos: new Set() });
    a.hijos.add(pid);
    const ev = pd(cob.evidenciaFecha), ocF = pd(cob.ocFecha), ac = pd(cob.acuseFecha), pg = pd(cob.pago && cob.pago.fecha);
    const termId = Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null;
    const plazo = termId != null && daysByTerm[termId] != null ? daysByTerm[termId] : CREDITO_DEFAULT;
    if (ev != null && ocF != null && ocF >= ev) {
      a.ocSum += Math.min(120, Math.round((ocF - ev) / DAY)); a.ocN++; a.ops.add(o.id);
    }
    if (ac != null && pg != null) {
      const desv = Math.max(-30, Math.min(120, Math.round((pg - (ac + plazo * DAY)) / DAY)));
      a.pagoSum += desv; a.pagoN++; a.ops.add(o.id);
      a.plazos[plazo] = (a.plazos[plazo] || 0) + 1;
    }
  }

  const nivelOC = (d) => (d == null ? "ambar" : d <= 10 ? "verde" : d <= 20 ? "ambar" : "rojo");
  const nivelPago = (d) => (d == null ? "ambar" : d <= 5 ? "verde" : d <= 15 ? "ambar" : "rojo");
  const COL = { verde: "#16a34a", ambar: "#e8a317", rojo: "#dc2626" };
  const lista = [], porPartner = {};
  for (const madre of Object.keys(acc)) {
    const a = acc[madre]; if (!a.ops.size) continue;
    const oc = a.ocN ? Math.round(a.ocSum / a.ocN) : null;
    const pago = a.pagoN ? Math.round(a.pagoSum / a.pagoN) : null;
    const termino = Object.entries(a.plazos).sort((x, y) => y[1] - x[1])[0];
    const nOC = nivelOC(oc), nP = nivelPago(pago);
    const letra = nOC === "verde" && nP === "verde" ? "A" : (nOC === "rojo" || nP === "rojo") ? "C" : "B";
    const item = { nombre: nombreMadre[madre] || "Cliente", oc, pago,
      termino: termino ? Number(termino[0]) : CREDITO_DEFAULT, operaciones: a.ops.size };
    lista.push({ ...item, _sev: letra === "C" ? 0 : letra === "B" ? 1 : 2 });
    const chip = { letra, color: COL[letra === "A" ? "verde" : letra === "B" ? "ambar" : "rojo"],
      oc: oc == null ? "s/d" : oc, pago: pago == null ? "s/d" : (pago > 0 ? "+" + pago : String(pago)) };
    porPartner[madre] = chip;
    for (const h of a.hijos) porPartner[h] = chip;
  }
  lista.sort((x, y) => x._sev - y._sev || (y.operaciones - x.operaciones));
  lista.forEach((x) => delete x._sev);
  return { lista, porPartner };
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const u = new URL(req.url);
    const { lista, porPartner } = await calcularScores();
    if (u.searchParams.get("json") === "1") return json({ ok: true, porPartner, clientes: lista.length });
    const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
    const d = new Date(Date.now() - 6 * 3600000);
    const hoyTxt = d.getUTCDate() + " " + MESES[d.getUTCMonth()] + " " + d.getUTCFullYear();
    let html = TPL.replace(CLIENTES_BLOCK, "const CLIENTES = " + JSON.stringify(lista) + ";");
    html = html.split("17 jul 2026").join(hoyTxt);
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
