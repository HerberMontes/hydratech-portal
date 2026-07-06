// netlify/functions/cobranza-recordatorios.js
// RECORDATORIOS DE PAGO por correo, con estado de cuenta POR CLIENTE.
//
// Regla de envío (cadencia estándar de cobranza B2B):
//   - Un cliente recibe correo cuando tiene AL MENOS UNA orden con acuse cuyo
//     pago vence en ≤7 días o ya venció (y sin pago registrado).
//   - El correo lleva su estado de cuenta COMPLETO: todas sus órdenes por
//     pagar con acuse, separando VENCIDO vs POR VENCER, con totales.
//   - Anti-spam: no se reenvía a un cliente si ya se le envió hace <6 días.
//   - Se envía DESDE ODOO (mail.mail → usa tu servidor de correo saliente
//     configurado en Odoo) y se deja constancia en el chatter de cada orden.
//
// USO (con sesión iniciada):
//   GET /api/cobranza-recordatorios            -> VISTA PREVIA (no envía nada)
//   GET /api/cobranza-recordatorios?enviar=1   -> ENVÍA los correos
//
// Variables de entorno (opcionales, en Netlify):
//   COBRANZA_CORREO_PRUEBA  -> si está definida, TODOS los correos se mandan a
//                              esa dirección (modo prueba). Quítala para enviar
//                              a los clientes reales.
//   COBRANZA_CC             -> correo(s) en copia, separados por coma.
//   COBRANZA_DATOS_PAGO     -> texto con los datos bancarios para el correo.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const DESDE = process.env.REPORTES_DESDE || "";
const EXTRA = (process.env.COBRANZA_EXTRA || "").split(",").map((s) => s.trim()).filter(Boolean);
const CORREO_PRUEBA = (process.env.COBRANZA_CORREO_PRUEBA || "").trim();
// Días de crédito por defecto cuando la orden no tiene Términos de pago en Odoo
const CREDITO_DEFAULT = parseInt(process.env.COBRANZA_CREDITO_DIAS || "30", 10) || 30;
const CC = (process.env.COBRANZA_CC || "").trim();
// Datos del bloque "Datos para pago" y contacto de la firma (Netlify → env vars)
const BANCO = (process.env.COBRANZA_BANCO || "").trim();
const BENEFICIARIO = (process.env.COBRANZA_BENEFICIARIO || "HydraTech Group").trim();
const CLABE = (process.env.COBRANZA_CLABE || "").trim();
const CORREO_CONTACTO = (process.env.COBRANZA_CORREO_CONTACTO || "administracion@hydratechgroup.mx").trim();
// Logo del encabezado: se toma del propio portal publicado (Netlify define URL).
// Se puede forzar otra dirección con COBRANZA_LOGO_URL.
const LOGO_URL = (process.env.COBRANZA_LOGO_URL ||
  (process.env.URL ? String(process.env.URL).replace(/\/+$/, "") + "/assets/hydratech-wordmark-white.png" : "")).trim();
const TELEFONO = (process.env.COBRANZA_TELEFONO || "").trim();

const COB = "portal_cobranza.json";
const ACUSE_PREFIX = "portal_acuse";
const DAY = 24 * 60 * 60 * 1000;
const DIAS_AVISO = 7;        // se avisa cuando vence en ≤7 días (o ya vencido)
const DIAS_ANTISPAM = 6;     // no reenviar si ya se envió hace menos de 6 días

function AND(subs) {
  subs = subs.filter((s) => s && s.length);
  if (!subs.length) return [];
  let d = [];
  for (let i = 0; i < subs.length - 1; i++) d.push("&");
  for (const s of subs) d = d.concat(s);
  return d;
}
function parseDate(s) { if (!s) return null; const t = Date.parse(String(s).replace(" ", "T") + (String(s).length <= 10 ? "T00:00:00Z" : "Z")); return isNaN(t) ? null : t; }
function addDays(s, n) { const t = parseDate(s); if (t == null) return ""; return new Date(t + n * DAY).toISOString().slice(0, 10); }
function hoyISO() { return new Date().toISOString().slice(0, 10); }
const mxn = (n) => "$" + (Number(n) || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtF = (s) => { if (!s) return "—"; const p = String(s).slice(0, 10).split("-"); const M = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"]; return (+p[2]) + " " + M[(+p[1]) - 1] + " " + p[0]; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));


const fmtLarga = (s) => { const p = String(s).slice(0,10).split("-"); const M=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"]; return (+p[2]) + " de " + M[(+p[1])-1] + " de " + p[0]; };

/* ============ PLANTILLA DEL CORREO (diseño aprobado en Claude Design) ============ */
const PLANTILLA = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Estado de cuenta · HydraTech Group</title>
</head>
<body style="margin:0; padding:0; background-color:#eef0f4; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">

<!-- Preheader oculto -->
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#eef0f4;">
Estado de cuenta al {{FECHA}} — Total {{TOTAL}} MXN.{{PRE_VENCIDO}}
</div>

<!-- Wrapper exterior -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef0f4;">
<tr>
<td align="center" style="padding:24px 12px;">

<!-- Contenedor 680px -->
<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px; max-width:680px; background-color:#ffffff; border:1px solid #e6e9f0; border-radius:6px; overflow:hidden;">

  <!-- 1. Encabezado -->
  <tr>
    <td style="background-color:#141829; padding:22px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="left" style="vertical-align:middle;">
          {{MARCA}}
        </td>
        <td align="right" style="vertical-align:middle;">
          <span style="font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:700; color:#8f9bc4; letter-spacing:2.5px; text-transform:uppercase;">Estado de cuenta</span>
        </td>
      </tr>
      </table>
    </td>
  </tr>

  <!-- 2. Saludo y propósito -->
  <tr>
    <td style="padding:30px 32px 22px 32px;">
      <p style="margin:0 0 6px 0; font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:700; color:#717a90; letter-spacing:2px; text-transform:uppercase;">{{CLIENTE}}</p>
      <p style="margin:0 0 14px 0; font-family:Arial,Helvetica,sans-serif; font-size:17px; font-weight:800; color:#1b2138; line-height:1.3;">Estimado cliente:</p>
      <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:400; color:#4a5267; line-height:1.55;">Le compartimos su estado de cuenta al <strong style="color:#1b2138;">{{FECHA_LARGA}}</strong> como recordatorio de los pagos próximos a vencer o vencidos. Agradecemos su atención para mantener su cuenta al corriente.</p>
    </td>
  </tr>

  <!-- 3. Resumen en franja -->
  <tr>
    <td style="padding:0 32px 26px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; border-spacing:0;">
      <tr>
        <!-- Saldo vencido -->
        <td width="34%" style="background-color:{{VEN_BG}}; border:1px solid {{VEN_BORDE}}; border-radius:6px; padding:16px 18px; vertical-align:top;">
          <p style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:{{VEN_COLOR}}; letter-spacing:1.5px; text-transform:uppercase;">Saldo vencido</p>
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:20px; font-weight:800; color:{{VEN_COLOR}}; line-height:1;">{{VENCIDO}}</p>
        </td>
        <td width="12" style="font-size:0; line-height:0;">&nbsp;</td>
        <!-- Saldo por vencer -->
        <td width="34%" style="background-color:#f7f8fb; border:1px solid #e6e9f0; border-radius:6px; padding:16px 18px; vertical-align:top;">
          <p style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#717a90; letter-spacing:1.5px; text-transform:uppercase;">Saldo por vencer</p>
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:20px; font-weight:800; color:#1b2138; line-height:1;">{{PORVENCER}}</p>
        </td>
        <td width="12" style="font-size:0; line-height:0;">&nbsp;</td>
        <!-- Total -->
        <td style="background-color:#263370; border:1px solid #263370; border-radius:6px; padding:16px 18px; vertical-align:top;">
          <p style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#b8c1e4; letter-spacing:1.5px; text-transform:uppercase;">Total</p>
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:22px; font-weight:800; color:#ffffff; line-height:1;">{{TOTAL}}<span style="font-size:11px; font-weight:700; color:#b8c1e4;">&nbsp;MXN</span></p>
        </td>
      </tr>
      </table>
    </td>
  </tr>

  <!-- 4. Tabla de detalle -->
  <tr>
    <td style="padding:0 32px 8px 32px;">
      <p style="margin:0 0 12px 0; font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:700; color:#1b2138; letter-spacing:2px; text-transform:uppercase;">Detalle de documentos</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <!-- Encabezados -->
        <tr>
          <td style="padding:0 8px 8px 0; border-bottom:2px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#717a90; letter-spacing:1px; text-transform:uppercase; text-align:left;">Orden</td>
          <td style="padding:0 8px 8px 8px; border-bottom:2px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#717a90; letter-spacing:1px; text-transform:uppercase; text-align:left;">OC / Ref.</td>
          <td style="padding:0 8px 8px 8px; border-bottom:2px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#717a90; letter-spacing:1px; text-transform:uppercase; text-align:left;">Acuse</td>
          <td style="padding:0 8px 8px 8px; border-bottom:2px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#717a90; letter-spacing:1px; text-transform:uppercase; text-align:left;">Vence</td>
          <td style="padding:0 8px 8px 8px; border-bottom:2px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#717a90; letter-spacing:1px; text-transform:uppercase; text-align:left;">Estado</td>
          <td style="padding:0 0 8px 8px; border-bottom:2px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; color:#717a90; letter-spacing:1px; text-transform:uppercase; text-align:right;">Monto</td>
        </tr>

        {{FILAS}}
<!-- Totales -->
        <tr>
          <td colspan="4" style="padding:14px 8px 4px 0;">&nbsp;</td>
          <td style="padding:14px 8px 4px 8px; font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:700; color:#717a90; letter-spacing:0.5px; text-transform:uppercase; text-align:right;">Total</td>
          <td style="padding:14px 0 4px 8px; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:800; color:#263370; text-align:right; white-space:nowrap;">{{TOTAL}}</td>
        </tr>
      </table>
    </td>
  </tr>

  {{BLOQUE_PAGO}}

  <!-- 6. Nota de cortesía -->
  <tr>
    <td style="padding:18px 32px 4px 32px;">
      <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:400; color:#4a5267; line-height:1.55;">Si ya realizó su pago, por favor comparta el comprobante y el complemento de pago para aplicarlo de inmediato. Si detecta alguna diferencia, con gusto la revisamos.</p>
    </td>
  </tr>

  <!-- 7. Firma -->
  <tr>
    <td style="padding:22px 32px 26px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="border-top:1px solid #e6e9f0; padding-top:18px;">
          <p style="margin:0 0 3px 0; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:800; color:#1b2138;">Administración y Cobranza</p>
          <p style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:700; color:#263370; letter-spacing:0.3px;">HydraTech Group</p>
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:400; color:#4a5267; line-height:1.6;">{{CORREO}}&nbsp;&nbsp;·&nbsp;&nbsp;Tel. {{TELEFONO}}</p>
        </td>
      </tr>
      </table>
    </td>
  </tr>

  <!-- 8. Pie legal -->
  <tr>
    <td style="background-color:#f7f8fb; border-top:1px solid #e6e9f0; padding:16px 32px;">
      <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:400; color:#717a90; line-height:1.5;">Este mensaje y sus adjuntos son confidenciales y de uso exclusivo del destinatario; si lo recibió por error, notifíquelo y elimínelo.</p>
    </td>
  </tr>

</table>
<!-- Fin contenedor -->

<!-- Firma exterior mínima -->
<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px; max-width:680px;">
<tr>
  <td align="center" style="padding:16px 12px 4px 12px;">
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:400; color:#8f9bc4;">HydraTech Group · Monterrey, N.L.</p>
  </td>
</tr>
</table>

</td>
</tr>
</table>

</body>
</html>
`;
const FILA_VENCIDA = `<tr style="background-color:#fdf3f3;">
          <td style="padding:12px 8px 12px 0; border-bottom:1px solid #f2d4d5; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138;">{{FOLIO}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #f2d4d5; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:400; color:#4a5267;">{{REF}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #f2d4d5; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:400; color:#4a5267;">{{ACUSE}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #f2d4d5; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:400; color:#4a5267;">{{VENCE}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #f2d4d5; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:700; color:#b0272b;">{{ESTADO}}</td>
          <td style="padding:12px 0 12px 8px; border-bottom:1px solid #f2d4d5; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138; text-align:right; white-space:nowrap;">{{MONTO}}</td>
        </tr>`;
const FILA_NORMAL = `<tr>
          <td style="padding:12px 8px 12px 0; border-bottom:1px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138;">{{FOLIO}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:400; color:#4a5267;">{{REF}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:400; color:#4a5267;">{{ACUSE}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:400; color:#4a5267;">{{VENCE}}</td>
          <td style="padding:12px 8px; border-bottom:1px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:700; color:#157f3b;">{{ESTADO}}</td>
          <td style="padding:12px 0 12px 8px; border-bottom:1px solid #e6e9f0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138; text-align:right; white-space:nowrap;">{{MONTO}}</td>
        </tr>`;

const BLOQUE_PAGO = `<!-- 5. Datos para pago -->
  <tr>
    <td style="padding:18px 32px 4px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f8fb; border:1px solid #e6e9f0; border-radius:6px;">
      <tr>
        <td style="padding:18px 22px;">
          <p style="margin:0 0 14px 0; font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:700; color:#1b2138; letter-spacing:2px; text-transform:uppercase;">Datos para pago</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="130" style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:400; color:#717a90; vertical-align:top;">Banco</td>
              <td style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138; vertical-align:top;">{{BANCO}}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:400; color:#717a90; vertical-align:top;">Beneficiario</td>
              <td style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138; vertical-align:top;">{{BENEFICIARIO}}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:400; color:#717a90; vertical-align:top;">CLABE</td>
              <td style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138; letter-spacing:1px; vertical-align:top;">{{CLABE}}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; font-weight:400; color:#717a90; vertical-align:top;">Referencia</td>
              <td style="padding:4px 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:700; color:#1b2138; vertical-align:top;">{{REFERENCIA}}</td>
            </tr>
          </table>
        </td>
      </tr>
      </table>
    </td>
  </tr>`;

function armarHTML(cliente, ordenes, totV, totP) {
  const filas = ordenes.map((o) => {
    const estado = o.vencida
      ? "VENCIDO · " + Math.abs(o.diasParaPago) + " d"
      : (o.diasParaPago === 0 ? "vence hoy" : "vence en " + o.diasParaPago + " d");
    return (o.vencida ? FILA_VENCIDA : FILA_NORMAL)
      .replace(/{{FOLIO}}/g, esc(o.folio))
      .replace(/{{REF}}/g, esc(o.referencia || "—"))
      .replace(/{{ACUSE}}/g, esc(o.acuseFolio || "—"))
      .replace(/{{VENCE}}/g, fmtF(o.fechaPago))
      .replace(/{{ESTADO}}/g, estado)
      .replace(/{{MONTO}}/g, mxn(o.monto));
  }).join("\n");
  const hayVencido = totV > 0;
  // Marca del encabezado: logo PNG del portal; si no hay URL (entorno local),
  // respaldo en texto. El alt garantiza que se lea aunque bloqueen imágenes.
  const marca = LOGO_URL
    ? '<img src="' + LOGO_URL + '" alt="HydraTech Group" height="26" style="display:block; height:26px; border:0; outline:none;">'
    : `<span style="font-family:Arial,Helvetica,sans-serif; font-size:21px; font-weight:800; color:#ffffff; letter-spacing:-0.2px;">HydraTech</span><span style="font-family:Arial,Helvetica,sans-serif; font-size:21px; font-weight:400; color:#8f9bc4; letter-spacing:-0.2px;">&nbsp;Group</span>`;
  return PLANTILLA
    .replace(/{{MARCA}}/g, marca)
    .replace(/{{FILAS}}/g, filas)
    .replace(/{{CLIENTE}}/g, esc(cliente))
    .replace(/{{FECHA}}/g, fmtF(hoyISO()))
    .replace(/{{FECHA_LARGA}}/g, fmtLarga(hoyISO()))
    .replace(/{{VENCIDO}}/g, mxn(totV))
    .replace(/{{PORVENCER}}/g, mxn(totP))
    .replace(/{{TOTAL}}/g, mxn(totV + totP))
    .replace(/{{PRE_VENCIDO}}/g, hayVencido ? " Saldo vencido " + mxn(totV) + "." : "")
    // tarjeta de vencido: roja si hay saldo vencido, neutra si no
    .replace(/{{VEN_BG}}/g, hayVencido ? "#fdf3f3" : "#f7f8fb")
    .replace(/{{VEN_BORDE}}/g, hayVencido ? "#f2d4d5" : "#e6e9f0")
    .replace(/{{VEN_COLOR}}/g, hayVencido ? "#b0272b" : "#717a90")
    // Bloque bancario: solo si se configuraron los datos (COBRANZA_BANCO/CLABE).
    // Sin configurar, el correo va SIN la sección — los clientes ya tienen la cuenta.
    .replace(/{{BLOQUE_PAGO}}/g, (BANCO || CLABE) ? BLOQUE_PAGO
      .replace(/{{BANCO}}/g, esc(BANCO || "—"))
      .replace(/{{BENEFICIARIO}}/g, esc(BENEFICIARIO))
      .replace(/{{CLABE}}/g, esc(CLABE || "—"))
      .replace(/{{REFERENCIA}}/g, esc(cliente)) : "")
    .replace(/{{CORREO}}/g, esc(CORREO_CONTACTO))
    .replace(/{{TELEFONO}}/g, esc(TELEFONO || "(81) 0000 0000"));
}


export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  const url = new URL(req.url);
  const enviar = url.searchParams.get("enviar") === "1";
  let manual = null; // POST {partnerId, correo, actualizarContacto} = envío manual editado
  if (req.method === "POST") {
    try { manual = await req.json(); } catch (e) { return json({ ok: false, error: "Cuerpo inválido." }, 400); }
    if (!manual || !manual.partnerId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(manual.correo || "").trim()))
      return json({ ok: false, error: "Falta el destinatario o el correo no es válido." }, 400);
  }
  try {
    const now = Date.now();

    /* 1) Universo (idéntico a cobranza-listar) */
    const subs = [];
    if (DESDE && EXTRA.length) subs.push(["|", ["date_order", ">=", DESDE + " 00:00:00"], ["name", "in", EXTRA]]);
    else if (DESDE) subs.push([["date_order", ">=", DESDE + " 00:00:00"]]);
    else if (EXTRA.length) subs.push([["name", "in", EXTRA]]);
    subs.push([["state", "in", ["sale", "done"]]]);
    const orders = await executeKw("sale.order", "search_read", [AND(subs)],
      { fields: ["id", "name", "partner_id", "amount_total", "payment_term_id", "invoice_ids"], limit: 300 });
    if (!orders.length) return json({ ok: true, clientes: [], nota: "No hay órdenes en cobranza." });
    const ids = orders.map((o) => o.id);

    /* 2) Datos de cobranza + acuses */
    const atts = await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "in", ids],
        "|", ["name", "=", COB], ["name", "like", ACUSE_PREFIX + "%"]]],
      { fields: ["id", "res_id", "name", "datas"], limit: 1000 });
    const cobByOrder = {}, cobAttId = {}, acuseByOrder = {};
    for (const a of atts) {
      if (a.name === COB) { cobAttId[a.res_id] = a.id; try { cobByOrder[a.res_id] = JSON.parse(Buffer.from(a.datas || "", "base64").toString("utf8")); } catch (e) {} }
      else acuseByOrder[a.res_id] = true;
    }

    /* 3) Días de crédito por término de pago (igual que listar) */
    const termIds = [...new Set(orders.map((o) => Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null).filter(Boolean))];
    const daysByTerm = {};
    if (termIds.length) {
      // El campo cambió de nombre entre versiones de Odoo (nb_days en 17+,
      // days en 16-). Pedir ambos a la vez truena la consulta completa, así
      // que se intenta uno y luego el otro.
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

    /* 4) Monto real: facturado cuando hay factura timbrada */
    const facturaIds = [...new Set(orders.flatMap((o) => Array.isArray(o.invoice_ids) ? o.invoice_ids : []))];
    const facturadoPorOrden = {};
    if (facturaIds.length) {
      const moves = await executeKw("account.move", "search_read",
        [[["id", "in", facturaIds], ["state", "=", "posted"], ["move_type", "in", ["out_invoice", "out_refund"]]]],
        { fields: ["id", "amount_total", "move_type"], limit: 1000 }).catch(() => []);
      const montoMove = {};
      moves.forEach((m) => { montoMove[m.id] = (m.move_type === "out_refund" ? -1 : 1) * (m.amount_total || 0); });
      orders.forEach((o) => {
        const t = (Array.isArray(o.invoice_ids) ? o.invoice_ids : []).reduce((a, mid) => a + (montoMove[mid] || 0), 0);
        if (t > 0) facturadoPorOrden[o.id] = t;
      });
    }

    /* 5) Órdenes POR PAGAR con acuse y su vencimiento */
    const porCliente = {}; // partnerId -> { nombre, ordenes:[] }
    const diag = { ordenesEnUniverso: orders.length, sinAcuse: 0, yaPagadas: 0, sinFechaAcuse: 0, consideradas: 0 };
    for (const o of orders) {
      const cob = cobByOrder[o.id] || {};
      const pagado = !!(cob.pago && cob.pago.complemento) || !!cob.pago; // con pago registrado ya no se recuerda
      const tieneAcuse = !!acuseByOrder[o.id] || !!cob.acuseFecha;
      if (!tieneAcuse) { diag.sinAcuse++; continue; }
      if (pagado) { diag.yaPagadas++; continue; }
      if (cob.archivada) continue;
      const termId = Array.isArray(o.payment_term_id) ? o.payment_term_id[0] : null;
      // Sin términos de pago en la orden: crédito por defecto (COBRANZA_CREDITO_DIAS, 30 si no se define)
      const plazo = termId != null && daysByTerm[termId] != null ? daysByTerm[termId] : CREDITO_DEFAULT;
      if (!cob.acuseFecha) { diag.sinFechaAcuse++; continue; }
      const fechaPago = addDays(cob.acuseFecha, plazo);
      const fp = parseDate(fechaPago);
      const diasParaPago = fp != null ? Math.round((fp - now) / DAY) : null;
      if (diasParaPago == null) continue;
      diag.consideradas++;
      const pid = Array.isArray(o.partner_id) ? o.partner_id[0] : 0;
      const pname = Array.isArray(o.partner_id) ? o.partner_id[1] : "—";
      (porCliente[pid] = porCliente[pid] || { partnerId: pid, cliente: pname, ordenes: [] }).ordenes.push({
        id: o.id, folio: o.name,
        referencia: (cob.oc || "").trim(),
        acuseFolio: (cob.acuseFolio || "").trim(),
        fechaPago, diasParaPago,
        vencida: diasParaPago < 0,
        monto: facturadoPorOrden[o.id] != null ? facturadoPorOrden[o.id] : (o.amount_total || 0),
        ultimoRecordatorio: cob.ultimoRecordatorio || "",
        _attId: cobAttId[o.id] || null, _cob: cob,
      });
    }

    /* 6) Correos de los clientes (res.partner, con respaldo en el padre) */
    const pids = Object.keys(porCliente).map(Number).filter(Boolean);
    const partners = pids.length ? await executeKw("res.partner", "read", [pids, ["email", "parent_id"]]).catch(() => []) : [];
    const emailDe = {}, padreDe = {};
    partners.forEach((p) => { emailDe[p.id] = (p.email || "").trim(); padreDe[p.id] = Array.isArray(p.parent_id) ? p.parent_id[0] : null; });
    const padresSinCorreo = [...new Set(partners.filter((p) => !emailDe[p.id] && padreDe[p.id]).map((p) => padreDe[p.id]))];
    if (padresSinCorreo.length) {
      const pads = await executeKw("res.partner", "read", [padresSinCorreo, ["email"]]).catch(() => []);
      const eP = {}; pads.forEach((p) => { eP[p.id] = (p.email || "").trim(); });
      pids.forEach((id) => { if (!emailDe[id] && padreDe[id] && eP[padreDe[id]]) emailDe[id] = eP[padreDe[id]]; });
    }

    /* 7) Decidir a quién se envía */
    const clientes = [];
    for (const pid of Object.keys(porCliente)) {
      const c = porCliente[pid];
      c.ordenes.sort((a, b) => a.diasParaPago - b.diasParaPago);
      const detona = c.ordenes.some((o) => o.diasParaPago <= DIAS_AVISO);
      const correo = emailDe[c.partnerId] || "";
      const reciente = c.ordenes.every((o) => o.ultimoRecordatorio && (now - (parseDate(o.ultimoRecordatorio) || 0)) < DIAS_ANTISPAM * DAY);
      const totV = c.ordenes.filter((o) => o.vencida).reduce((a, o) => a + o.monto, 0);
      const totP = c.ordenes.filter((o) => !o.vencida).reduce((a, o) => a + o.monto, 0);
      let omitido = "";
      if (!detona) omitido = "sin vencimientos en los próximos " + DIAS_AVISO + " días";
      else if (!correo) omitido = "SIN CORREO en Odoo (captúralo en el contacto)";
      else if (reciente) omitido = "recordatorio enviado hace menos de " + DIAS_ANTISPAM + " días";
      clientes.push({
        cliente: c.cliente, correo: correo || "—",
        seEnvia: !omitido, omitido: omitido || undefined,
        totalVencido: totV, totalPorVencer: totP,
        ordenes: c.ordenes.map(({ _attId, _cob, ...o }) => o),
        _c: c, _totV: totV, _totP: totP, _correo: correo,
      });
    }
    clientes.sort((a, b) => (b.seEnvia ? 1 : 0) - (a.seEnvia ? 1 : 0) || b.totalVencido - a.totalVencido);
    const aEnviar = clientes.filter((c) => c.seEnvia);

    /* ENVÍO MANUAL: destinatario editado a mano desde la vista previa.
       Ignora el anti-spam (es intención explícita) y opcionalmente actualiza
       el correo del contacto en Odoo para la próxima. */
    if (manual) {
      const c = clientes.find((x) => x._c.partnerId === Number(manual.partnerId));
      if (!c) return json({ ok: false, error: "Cliente no encontrado en cobranza." }, 404);
      const correoManual = String(manual.correo).trim();
      const destino = CORREO_PRUEBA || correoManual;
      const html = armarHTML(c._c.cliente, c._c.ordenes, c._totV, c._totP);
      const vals = { subject: "Estado de cuenta y recordatorio de pago · HydraTech Group", body_html: html, email_to: destino, auto_delete: false };
      if (CC) vals.email_cc = CC;
      const mailId = await executeKw("mail.mail", "create", [vals]);
      await executeKw("mail.mail", "send", [[mailId]]).catch(() => {});
      for (const o of c._c.ordenes) {
        await executeKw("sale.order", "message_post", [[o.id]],
          { body: "Estado de cuenta enviado MANUALMENTE a " + destino + " (" + hoyISO() + ")." }).catch(() => {});
        const data = { ...(o._cob || {}), ultimoRecordatorio: hoyISO() };
        const datas = Buffer.from(JSON.stringify(data)).toString("base64");
        if (o._attId) await executeKw("ir.attachment", "write", [[o._attId], { datas }]).catch(() => {});
        else await executeKw("ir.attachment", "create", [{ name: COB, res_model: "sale.order", res_id: o.id, type: "binary", mimetype: "application/json", datas }]).catch(() => {});
      }
      let contactoActualizado = false;
      if (manual.actualizarContacto) {
        contactoActualizado = await executeKw("res.partner", "write",
          [[c._c.partnerId], { email: correoManual }]).then(() => true).catch(() => false);
      }
      return json({ ok: true, enviadoA: destino, modoPrueba: CORREO_PRUEBA ? ("activo — correo real: " + correoManual) : false, contactoActualizado });
    }

    /* Modo VISUAL (?ver=1): muestra en el navegador los correos EXACTOS que se
       enviarían, cliente por cliente, con sus datos reales — para revisar y
       autorizar antes de enviar. No envía nada. */
    if (url.searchParams.get("ver") === "1") {
      const bloques = clientes.map((c) => {
        const pid = c._c.partnerId;
        const estado = c.seEnvia
          ? '<div style="max-width:680px;margin:26px auto 0;padding:10px 16px;background:#0f5132;color:#fff;border-radius:8px 8px 0 0;font:600 13px Arial">Envío automático: SÍ · <b>' + esc(c._c.cliente) + '</b>' + (CORREO_PRUEBA ? ' <span style="opacity:.8">(modo prueba activo: irá a ' + esc(CORREO_PRUEBA) + ')</span>' : '') + '</div>'
          : '<div style="max-width:680px;margin:26px auto 0;padding:10px 16px;background:#8a6a1f;color:#fff;border-radius:8px 8px 0 0;font:600 13px Arial">Envío automático: NO · <b>' + esc(c._c.cliente) + '</b> — ' + esc(c.omitido || "") + '</div>';
        // Destinatario EDITABLE: por si cambió el comprador o el contacto está desactualizado
        const editor = '<div style="max-width:680px;margin:0 auto 10px;padding:12px 16px;background:#fff;border:1px solid #d8deea;border-top:0;border-radius:0 0 8px 8px;font:400 13px Arial;color:#1b2138">'
          + 'Enviar a: <input type="email" id="correo-' + pid + '" value="' + esc(c._correo || "") + '" placeholder="correo@cliente.mx" style="font:inherit;border:1.5px solid #d8deea;border-radius:7px;padding:7px 10px;width:260px;margin:0 8px">'
          + '<label style="margin-right:10px;color:#4a5267;white-space:nowrap"><input type="checkbox" id="upd-' + pid + '" style="vertical-align:middle"> guardar en el contacto de Odoo</label>'
          + '<button onclick="enviarManual(' + pid + ')" id="btn-' + pid + '" style="font:600 13px Arial;background:#263370;color:#fff;border:0;border-radius:7px;padding:8px 16px;cursor:pointer">Enviar a este correo</button>'
          + '</div>';
        const correoHTML = armarHTML(c._c.cliente, c._c.ordenes, c._totV, c._totP);
        return estado + editor + correoHTML;
      }).join("");
      const scriptEnviar = '<scr' + 'ipt>async function enviarManual(pid){'
        + 'var i=document.getElementById("correo-"+pid), b=document.getElementById("btn-"+pid);'
        + 'var correo=(i.value||"").trim();'
        + 'if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(correo)){alert("Escribe un correo válido.");return;}'
        + 'if(!confirm("¿Enviar el estado de cuenta a "+correo+"?"))return;'
        + 'b.disabled=true;b.textContent="Enviando…";'
        + 'try{var r=await fetch("/api/cobranza-recordatorios",{method:"POST",headers:{"Content-Type":"application/json"},'
        + 'body:JSON.stringify({partnerId:pid,correo:correo,actualizarContacto:document.getElementById("upd-"+pid).checked})});'
        + 'var d=await r.json();'
        + 'if(d&&d.ok){b.textContent="✓ Enviado a "+d.enviadoA;b.style.background="#0f5132";'
        + 'if(d.contactoActualizado){var l=document.getElementById("upd-"+pid).parentNode;l.textContent="✓ contacto actualizado en Odoo";l.style.color="#0f5132";}}'
        + 'else{alert("No se pudo enviar: "+((d&&d.error)||"error"));b.disabled=false;b.textContent="Enviar a este correo";}}'
        + 'catch(e){alert("Sin conexión: "+e);b.disabled=false;b.textContent="Enviar a este correo";}}'
        + '</scr' + 'ipt>';
      const pagina = '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Vista previa · Recordatorios de pago</title></head>'
        + '<body style="margin:0;padding:0 0 60px;background:#dfe3ec">'
        + '<div style="max-width:680px;margin:0 auto;padding:22px 16px 4px;font:800 20px Arial;color:#141829">Vista previa de recordatorios · ' + aEnviar.length + ' correo(s) por enviar</div>'
        + '<div style="max-width:680px;margin:0 auto;padding:0 16px;font:400 13px Arial;color:#4a5267">Esto es EXACTAMENTE lo que recibirá cada cliente. Para enviarlos: misma dirección con <b>?enviar=1</b>. Nada se ha enviado todavía.</div>'
        + (clientes.length ? "" :
          '<div style="max-width:680px;margin:26px auto;padding:16px 20px;background:#fff;border:1.5px solid #e7d5a6;border-radius:10px;font:400 13px Arial;color:#1b2138">'
          + '<b>No hay clientes con órdenes por pagar calculables.</b> Diagnóstico: '
          + diag.ordenesEnUniverso + ' órdenes en cobranza · '
          + diag.sinAcuse + ' sin acuse (aún no llegan al paso de pago) · '
          + diag.yaPagadas + ' ya con pago registrado · '
          + diag.sinFechaAcuse + ' con acuse pero SIN FECHA de acuse (edítala desde la pantalla de cobranza) · '
          + diag.consideradas + ' consideradas.'
          + '</div>')
        + bloques
        + scriptEnviar
        + '</body></html>';
      return new Response(pagina, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (!enviar) {
      return json({
        ok: true, modo: "VISTA PREVIA — no se envió nada",
        configuracion: {
          modoPrueba: CORREO_PRUEBA ? ("ACTIVO — todos los correos irán a " + CORREO_PRUEBA) : "desactivado (se envía a los clientes reales)",
          copiaCC: CC || "(sin copia)",
          datosDePago: (BANCO || CLABE) ? "definidos — el correo incluye el bloque bancario" : "no configurados — el correo va SIN bloque bancario (los clientes ya tienen la cuenta). Para incluirlo algún día: COBRANZA_BANCO y COBRANZA_CLABE en Netlify.",
        },
        seEnviarian: aEnviar.length,
        clientes: clientes.map(({ _c, _totV, _totP, _correo, ...c }) => c),
        muestraHTML: aEnviar.length ? armarHTML(aEnviar[0]._c.cliente, aEnviar[0]._c.ordenes, aEnviar[0]._totV, aEnviar[0]._totP) : "",
        instruccion: "Si la lista es correcta, agrega ?enviar=1 a esta misma dirección. Sugerencia: primero define COBRANZA_CORREO_PRUEBA con tu propio correo y envíate una prueba.",
      });
    }

    /* 8) ENVIAR desde Odoo + constancia + sello anti-spam */
    let enviados = 0;
    const detalle = [];
    for (const c of aEnviar) {
      const asunto = "Estado de cuenta y recordatorio de pago · HydraTech Group";
      const html = armarHTML(c._c.cliente, c._c.ordenes, c._totV, c._totP);
      const destino = CORREO_PRUEBA || c._correo;
      const vals = { subject: asunto, body_html: html, email_to: destino, auto_delete: false };
      if (CC) vals.email_cc = CC;
      const mailId = await executeKw("mail.mail", "create", [vals]);
      await executeKw("mail.mail", "send", [[mailId]]).catch(() => {});
      for (const o of c._c.ordenes) {
        await executeKw("sale.order", "message_post", [[o.id]],
          { body: "Recordatorio de pago enviado a " + destino + " (estado de cuenta " + hoyISO() + ")." }).catch(() => {});
        const data = { ...(o._cob || {}), ultimoRecordatorio: hoyISO() };
        const datas = Buffer.from(JSON.stringify(data)).toString("base64");
        if (o._attId) await executeKw("ir.attachment", "write", [[o._attId], { datas }]).catch(() => {});
        else await executeKw("ir.attachment", "create", [{ name: COB, res_model: "sale.order", res_id: o.id, type: "binary", mimetype: "application/json", datas }]).catch(() => {});
      }
      enviados++;
      detalle.push({ cliente: c.cliente, correo: destino, ordenes: c._c.ordenes.length, total: c._totV + c._totP });
    }
    return json({ ok: true, correosEnviados: enviados, modoPrueba: CORREO_PRUEBA ? CORREO_PRUEBA : false, detalle });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
