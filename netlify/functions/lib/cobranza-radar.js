// netlify/functions/lib/cobranza-radar.js
// RADAR DE COBRANZA — correo-tablero ejecutivo diario para dirección.
// Toma la foto de la cartera (motor, sin enviar nada) y llena el template
// aprobado en Claude Design. Se envía a COBRANZA_RADAR_CORREO.
import { executeKw } from "./odoo.js";
import { correrCobranza } from "./cobranza-motor.js";

const TPL = "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"color-scheme\" content=\"light dark\">\n<title>Radar de Cobranza \u00b7 HydraTech</title>\n</head>\n<body style=\"margin:0;padding:0;background-color:#eef0f4;\">\n<span style=\"display:none;font-size:1px;color:#eef0f4;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;\">{{TOTAL_VENCIDO}} vencido \u00b7 {{NUM_VENCIDAS}} facturas \u00b7 {{TOTAL_DESCUBIERTO}} sin OC</span>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\" style=\"background-color:#eef0f4;\">\n<tr><td align=\"center\" style=\"padding:16px 8px 32px 8px;\">\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"640\" style=\"width:640px;max-width:640px;\">\n\n<!-- HEADER -->\n<tr><td style=\"background-color:#141829;border-bottom:3px solid #263370;padding:18px 24px;\">\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\">\n<tr>\n<td align=\"left\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:0.5px;\">\n<img src=\"{{LOGO_URL}}\" alt=\"HydraTech Group\" width=\"140\" height=\"28\" style=\"display:block;border:0;\">\n</td>\n<td align=\"right\" style=\"font-family:'Courier New',Courier,monospace;font-size:11px;font-weight:bold;color:#8ea0d8;letter-spacing:1px;white-space:nowrap;\">RADAR DE COBRANZA \u00b7 {{FECHA}}</td>\n</tr>\n</table>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:14px;\">&nbsp;</td></tr>\n\n<!-- 1. HERO -->\n<tr><td style=\"background-color:#dc2626;border-radius:8px;padding:26px 24px 22px 24px;\" align=\"center\">\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#fbd5d5;letter-spacing:2px;mso-line-height-rule:exactly;line-height:14px;\">DINERO EN RIESGO</div>\n<div style=\"font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:50px;font-weight:900;color:#ffffff;mso-line-height-rule:exactly;line-height:56px;\">{{TOTAL_VENCIDO}}</div>\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#fbd5d5;mso-line-height-rule:exactly;line-height:18px;\">VENCIDO \u00b7 {{NUM_VENCIDAS}} facturas \u00b7 la m\u00e1s vieja <span style=\"color:#ffffff;font-weight:bold;\">{{DIAS_MAX_VENCIDO}} d\u00edas</span></div>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:12px;\">&nbsp;</td></tr>\n\n<!-- 2. KPI ROW -->\n<tr><td style=\"background-color:#ffffff;border-radius:8px;padding:16px 8px;\">\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\">\n<tr>\n<td width=\"25%\" align=\"center\" style=\"padding:2px 6px;border-right:1px solid #e6e9f0;\">\n<div style=\"font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:17px;font-weight:900;color:#1b2138;line-height:22px;\">{{TOTAL_CARTERA}}</div>\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:bold;color:#46506a;letter-spacing:1px;line-height:14px;\">CARTERA TOTAL</div>\n</td>\n<td width=\"25%\" align=\"center\" style=\"padding:2px 6px;border-right:1px solid #e6e9f0;\">\n<div style=\"font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:17px;font-weight:900;color:#1b2138;line-height:22px;\">{{TOTAL_POR_VENCER}}</div>\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:bold;color:#46506a;letter-spacing:1px;line-height:14px;\">POR VENCER</div>\n</td>\n<td width=\"25%\" align=\"center\" style=\"padding:2px 6px;border-right:1px solid #e6e9f0;background-color:#fdf3e3;border-radius:6px;\">\n<div style=\"font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:17px;font-weight:900;color:#e8a317;line-height:22px;\">{{TOTAL_DESCUBIERTO}}</div>\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:bold;color:#b07a0a;letter-spacing:1px;line-height:14px;\">TRABAJO SIN OC</div>\n</td>\n<td width=\"25%\" align=\"center\" style=\"padding:2px 6px;\">\n<div style=\"font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:17px;font-weight:900;color:#1b2138;line-height:22px;\">{{CLIENTES_SALDO}}</div>\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:bold;color:#46506a;letter-spacing:1px;line-height:14px;\">CLIENTES CON SALDO</div>\n</td>\n</tr>\n</table>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:12px;\">&nbsp;</td></tr>\n\n<!-- 3. ENF\u00d3CATE HOY -->\n<tr><td style=\"background-color:#ffffff;border-radius:8px;padding:18px 20px 8px 20px;\">\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#1b2138;letter-spacing:1px;padding-bottom:12px;border-bottom:2px solid #141829;\">\ud83c\udfaf ENF\u00d3CATE HOY</div>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\">\n{{FILAS_FOCOS}}\n\n</table>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:12px;\">&nbsp;</td></tr>\n\n<!-- 4. TERM\u00d3METRO -->\n<tr><td style=\"background-color:#ffffff;border-radius:8px;padding:18px 20px 20px 20px;\">\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#46506a;letter-spacing:1.5px;padding-bottom:12px;\">ANTIG\u00dcEDAD DEL VENCIDO</div>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\">\n<tr>\n<td width=\"{{PCT_0_15}}%\" align=\"center\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#1b2138;padding-bottom:4px;\">{{AGING_0_15}}</td>\n<td width=\"{{PCT_16_30}}%\" align=\"center\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#1b2138;padding-bottom:4px;\">{{AGING_16_30}}</td>\n<td width=\"{{PCT_31_60}}%\" align=\"center\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#dc2626;padding-bottom:4px;\">{{AGING_31_60}}</td>\n<td width=\"{{PCT_60}}%\" align=\"center\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#991b1b;padding-bottom:4px;\">{{AGING_60}}</td>\n</tr>\n<tr>\n<td width=\"{{PCT_0_15}}%\" height=\"14\" style=\"background-color:#f6d78a;font-size:0;line-height:0;border-radius:4px 0 0 4px;\">&nbsp;</td>\n<td width=\"{{PCT_16_30}}%\" height=\"14\" style=\"background-color:#e8a317;font-size:0;line-height:0;\">&nbsp;</td>\n<td width=\"{{PCT_31_60}}%\" height=\"14\" style=\"background-color:#dc2626;font-size:0;line-height:0;\">&nbsp;</td>\n<td width=\"{{PCT_60}}%\" height=\"14\" style=\"background-color:#991b1b;font-size:0;line-height:0;border-radius:0 4px 4px 0;\">&nbsp;</td>\n</tr>\n<tr>\n<td align=\"center\" style=\"font-family:'Courier New',Courier,monospace;font-size:10px;color:#46506a;padding-top:5px;\">1\u201315 d</td>\n<td align=\"center\" style=\"font-family:'Courier New',Courier,monospace;font-size:10px;color:#46506a;padding-top:5px;\">16\u201330</td>\n<td align=\"center\" style=\"font-family:'Courier New',Courier,monospace;font-size:10px;color:#46506a;padding-top:5px;\">31\u201360 d</td>\n<td align=\"center\" style=\"font-family:'Courier New',Courier,monospace;font-size:10px;color:#46506a;padding-top:5px;\">+60 d</td>\n</tr>\n</table>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:12px;\">&nbsp;</td></tr>\n\n<!-- 5a. SIN SOLPED -->\n<tr><td style=\"background-color:#ffffff;border-radius:8px;padding:18px 20px;\">\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#1b2138;letter-spacing:0.5px;padding-bottom:10px;\">\u23f3 SIN SOLPED <span style=\"color:#b07a0a;\">({{NUM_SOLPED}})</span></div>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\">\n<tr>\n<td style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">FOLIO</td>\n<td style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">CLIENTE</td>\n<td align=\"right\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">D\u00cdAS</td>\n<td align=\"right\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">MONTO</td>\n</tr>\n{{FILAS_SOLPED}}\n\n</table>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:12px;\">&nbsp;</td></tr>\n\n<!-- 5b. ESPERANDO OC -->\n<tr><td style=\"background-color:#ffffff;border-radius:8px;padding:18px 20px;\">\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#1b2138;letter-spacing:0.5px;padding-bottom:10px;\">\ud83d\udcc4 ESPERANDO OC <span style=\"color:#b07a0a;\">({{NUM_OC}})</span></div>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\">\n<tr>\n<td style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">FOLIO</td>\n<td style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">CLIENTE</td>\n<td style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">SOLPED</td>\n<td align=\"right\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">D\u00cdAS</td>\n<td align=\"right\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">MONTO</td>\n</tr>\n{{FILAS_OC}}\n\n</table>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:12px;\">&nbsp;</td></tr>\n\n<!-- 5c. FACTURAS VENCIDAS -->\n<tr><td style=\"background-color:#ffffff;border-radius:8px;padding:18px 20px;\">\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#1b2138;letter-spacing:0.5px;padding-bottom:10px;\">\ud83d\udd34 FACTURAS VENCIDAS <span style=\"color:#dc2626;\">({{NUM_VENCIDAS}})</span></div>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\">\n<tr>\n<td style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">CLIENTE</td>\n<td style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">FACTURA</td>\n<td align=\"right\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">D\u00cdAS VENC.</td>\n<td align=\"right\" style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;color:#8a93ad;letter-spacing:1px;padding:0 0 6px 0;border-bottom:1px solid #e6e9f0;\">MONTO</td>\n</tr>\n{{FILAS_VENCIDAS}}\n\n</table>\n</td></tr>\n\n<tr><td style=\"font-size:0;line-height:0;height:16px;\">&nbsp;</td></tr>\n\n<!-- 6. PIE -->\n<tr><td align=\"center\" style=\"padding:0 20px;\">\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#46506a;line-height:18px;\">\ud83e\udd16 Hoy el sistema envi\u00f3 <b>{{CORREOS_HOY}}</b> recordatorios autom\u00e1ticos \u00b7 <b>{{WHATS_HOY}}</b> WhatsApps</div>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"center\" style=\"margin:14px auto 0 auto;\">\n<tr><td align=\"center\" bgcolor=\"#3a52a8\" style=\"background-color:#3a52a8;border-radius:6px;\">\n<a href=\"{{URL_PORTAL}}\" style=\"display:block;padding:12px 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;\">Abrir portal de cobranza</a>\n</td></tr>\n</table>\n<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#8a93ad;line-height:15px;padding-top:18px;\">HydraTech Group S.A. de C.V. \u00b7 Av. Industrias 1200, Parque Industrial Mitras, Garc\u00eda, N.L., M\u00e9xico<br>Reporte autom\u00e1tico generado por el sistema de cobranza. Informaci\u00f3n confidencial para uso interno.</div>\n</td></tr>\n\n</table>\n</td></tr>\n</table>\n</body>\n</html>\n";

const mxn = (n) => "$" + (Number(n) || 0).toLocaleString("es-MX", { maximumFractionDigits: 0 });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const fechaLarga = () => { const d = new Date(Date.now() - 6 * 3600000); return d.getUTCDate() + " de " + MESES[d.getUTCMonth()] + " de " + d.getUTCFullYear(); };

const TD_M = "font-family:'Courier New',Courier,monospace;font-size:12px;color:#46506a;padding:8px 8px 8px 0;border-bottom:1px solid #f0f2f7;";
const TD_B = "font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#1b2138;padding:8px 8px 8px 0;border-bottom:1px solid #f0f2f7;";
const TD_N = "font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#46506a;padding:8px 0 8px 8px;border-bottom:1px solid #f0f2f7;";
const TD_NB = "font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#1b2138;padding:8px 0 8px 8px;border-bottom:1px solid #f0f2f7;";
const TD_R = "font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#dc2626;padding:8px 0 8px 8px;border-bottom:1px solid #f0f2f7;";

function filaFoco(n, color, cliente, problema, accion) {
  return '<tr><td width="40" valign="top" style="padding:14px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td width="28" height="28" align="center" style="background-color:' + color + ';border-radius:14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;">' + n + '</td>' +
    '</tr></table></td><td valign="top" style="padding:14px 0;border-bottom:1px solid #e6e9f0;">' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#1b2138;line-height:20px;">' + esc(cliente) + '</div>' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#46506a;line-height:18px;padding:3px 0 6px 0;">' + problema + '</div>' +
    "<div style=\"font-family:'Courier New',Courier,monospace;font-size:11px;font-weight:bold;color:" + color + ';letter-spacing:1px;">&#9656; ' + accion + '</div></td></tr>';
}

export async function armarRadar() {
  const r = await correrCobranza({ enviar: false });
  const clientes = r.clientes || [], solped = r.solped || [], oc = r.oc || [];

  const vencidas = [], porVencer = [];
  for (const c of clientes) for (const o of (c.ordenes || [])) {
    if (o.dias < 0) vencidas.push({ cliente: c.cliente, factura: o.factura || o.folio, dv: -o.dias, monto: o.monto });
    else porVencer.push({ monto: o.monto });
  }
  vencidas.sort((a, b) => b.dv - a.dv || b.monto - a.monto);

  const totalVencido = vencidas.reduce((a, x) => a + x.monto, 0);
  const totalPorVencer = porVencer.reduce((a, x) => a + x.monto, 0);
  const totalDescubierto = [...solped, ...oc].reduce((a, x) => a + (x.monto || 0), 0);
  const totalCartera = totalVencido + totalPorVencer + totalDescubierto;
  const clientesSaldo = new Set([...clientes.map((c) => c.cliente), ...solped.map((s) => s.cliente), ...oc.map((s) => s.cliente)]).size;

  const bk = { a: 0, b: 0, c: 0, d: 0 };
  for (const v of vencidas) { if (v.dv <= 15) bk.a += v.monto; else if (v.dv <= 30) bk.b += v.monto; else if (v.dv <= 60) bk.c += v.monto; else bk.d += v.monto; }
  const tot = bk.a + bk.b + bk.c + bk.d;
  const pct = (x) => (tot ? Math.max(6, Math.round((x / tot) * 100)) : 25);

  const focos = [];
  if (vencidas[0]) focos.push({ color: "#dc2626", cliente: vencidas[0].cliente,
    problema: '<span style="color:#dc2626;font-weight:bold;">' + mxn(vencidas[0].monto) + '</span> con ' + vencidas[0].dv + ' d&iacute;as vencido',
    accion: vencidas[0].dv >= 15 ? "LLAMAR HOY" : "COBRAR &mdash; REQUERIMIENTO ACTIVO" });
  const oc1 = [...oc].sort((a, z) => z.dias - a.dias)[0];
  if (oc1) focos.push({ color: oc1.dias > 10 ? "#dc2626" : "#e8a317", cliente: oc1.cliente,
    problema: "SolPed <span style=\"font-family:'Courier New',monospace;\">" + esc(oc1.solped) + "</span> estancada " + oc1.dias + " d&iacute;as (" + mxn(oc1.monto || 0) + ")",
    accion: "ESCALAR A SUPERVISOR" });
  const sp1 = [...solped].sort((a, z) => z.dias - a.dias)[0];
  if (sp1) focos.push({ color: sp1.dias > 7 ? "#dc2626" : "#e8a317", cliente: sp1.cliente,
    problema: esc(sp1.folio) + " entregado hace " + sp1.dias + " d&iacute;as sin SolPed (" + mxn(sp1.monto || 0) + ")",
    accion: "SOLICITAR SOLPED" });
  for (const v of vencidas.slice(1)) { if (focos.length >= 3) break;
    focos.push({ color: "#dc2626", cliente: v.cliente,
      problema: '<span style="color:#dc2626;font-weight:bold;">' + mxn(v.monto) + '</span> con ' + v.dv + ' d&iacute;as vencido',
      accion: v.dv >= 15 ? "LLAMAR HOY" : "COBRAR" }); }
  const filasFocos = focos.slice(0, 3).map((f, i) => filaFoco(i + 1, f.color, f.cliente, f.problema, f.accion)).join("") ||
    filaFoco(1, "#16a34a", "Cartera sana", "Sin focos rojos el d&iacute;a de hoy. &iexcl;Buen trabajo!", "MANTENER RITMO");

  const filasSolped = solped.map((s) => '<tr><td style="' + TD_M + '">' + esc(s.folio) + '</td><td style="' + TD_B + '">' + esc(s.cliente) + '</td><td align="right" style="' + TD_N + '">' + s.dias + '</td><td align="right" style="' + TD_NB + '">' + mxn(s.monto || 0) + '</td></tr>').join("") ||
    '<tr><td colspan="4" style="' + TD_N + '">Sin pendientes &#10003;</td></tr>';
  const filasOc = oc.map((s) => '<tr><td style="' + TD_M + '">' + esc(s.folio) + '</td><td style="' + TD_B + '">' + esc(s.cliente) + '</td><td style="' + TD_M + '">' + esc(s.solped) + '</td><td align="right" style="' + TD_N + '">' + s.dias + '</td><td align="right" style="' + TD_NB + '">' + mxn(s.monto || 0) + '</td></tr>').join("") ||
    '<tr><td colspan="5" style="' + TD_N + '">Sin pendientes &#10003;</td></tr>';
  const filasVenc = vencidas.map((v) => '<tr><td style="' + TD_B + '">' + esc(v.cliente) + '</td><td style="' + TD_M + '">' + esc(v.factura || "&mdash;") + '</td><td align="right" style="' + TD_R + '">' + v.dv + '</td><td align="right" style="' + TD_R + '">' + mxn(v.monto) + '</td></tr>').join("") ||
    '<tr><td colspan="4" style="' + TD_N + '">Sin facturas vencidas &#10003;</td></tr>';

  const correosHoy = [...solped, ...oc, ...clientes].filter((x) => x.seEnvia).length;
  const whatsHoy = [...solped, ...oc, ...clientes].reduce((a, x) => a + (x.seEnvia ? (x.whatsapps || 0) : 0), 0);
  const SITE = (process.env.URL || "").replace(/\/+$/, "");

  const vars = {
    LOGO_URL: process.env.COBRANZA_LOGO_URL || SITE + "/assets/hydratech-wordmark-white.png",
    FECHA: fechaLarga(),
    TOTAL_VENCIDO: mxn(totalVencido), NUM_VENCIDAS: vencidas.length,
    DIAS_MAX_VENCIDO: vencidas.length ? vencidas[0].dv : 0,
    TOTAL_CARTERA: mxn(totalCartera), TOTAL_POR_VENCER: mxn(totalPorVencer),
    TOTAL_DESCUBIERTO: mxn(totalDescubierto), CLIENTES_SALDO: clientesSaldo,
    FILAS_FOCOS: filasFocos,
    AGING_0_15: mxn(bk.a), AGING_16_30: mxn(bk.b), AGING_31_60: mxn(bk.c), AGING_60: mxn(bk.d),
    PCT_0_15: pct(bk.a), PCT_16_30: pct(bk.b), PCT_31_60: pct(bk.c), PCT_60: pct(bk.d),
    NUM_SOLPED: solped.length, FILAS_SOLPED: filasSolped,
    NUM_OC: oc.length, FILAS_OC: filasOc, FILAS_VENCIDAS: filasVenc,
    CORREOS_HOY: correosHoy, WHATS_HOY: whatsHoy,
    URL_PORTAL: SITE + "/ventas-cobranza.html",
  };
  const html = TPL.replace(/{{\s*([A-Z_0-9]+)\s*}}/g, (m, k) => (vars[k] != null ? String(vars[k]) : ""));
  const asunto = "\uD83D\uDCE1 Radar de cobranza \u2014 " + (vencidas.length ? mxn(totalVencido) + " vencido (" + vencidas.length + " fact.)" : "cartera sana") + " \u00B7 " + vars.FECHA;
  return { html, asunto, resumen: { totalCartera, totalVencido, totalPorVencer, totalDescubierto, facturasVencidas: vencidas.length, clientesSaldo, correosProgramadosHoy: correosHoy } };
}

export async function enviarRadar() {
  const destino = (process.env.COBRANZA_RADAR_CORREO || process.env.COBRANZA_CORREO_PRUEBA || "").trim();
  if (!destino) throw new Error("Configura COBRANZA_RADAR_CORREO en Netlify (tu correo).");
  const { html, asunto, resumen } = await armarRadar();
  const mailId = await executeKw("mail.mail", "create", [{ subject: asunto, body_html: html, email_to: destino, auto_delete: false }]);
  await executeKw("mail.mail", "send", [[mailId]]).catch(() => {});
  return { ok: true, destino, resumen };
}
