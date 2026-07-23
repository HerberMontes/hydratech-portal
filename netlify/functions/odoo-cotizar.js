// netlify/functions/odoo-cotizar.js
// POST /api/odoo-cotizar
// Body: { partnerId: number, lines: [{ name: string, price: number, qty?: number }], note?: string }
// Crea una COTIZACIÓN (sale.order en estado borrador) en Odoo. Cada manguera
// armada se mete como UNA línea, usando un producto genérico de Odoo pero
// sobrescribiendo la descripción (name) y el precio (price_unit). Así el cliente
// ve solo descripciones, nunca los códigos internos de mangueras/espigas.
//
// Requisito en Odoo (una sola vez): crear un producto con la referencia interna
// exacta GENERIC_REF (abajo). Si no existe, esta función responde con una
// instrucción clara para crearlo.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const GENERIC_REF = "MANG-ARMADA"; // referencia interna del producto genérico

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  if (req.method !== "POST") return json({ ok: false, error: "Usa POST." }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "JSON inválido." }, 400); }

  const partnerId = Number(body.partnerId);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!partnerId) return json({ ok: false, error: "Falta el cliente (partnerId)." }, 400);
  if (lines.length === 0) return json({ ok: false, error: "No hay líneas para cotizar." }, 400);

  try {
    // 1) Localiza el producto genérico por su referencia interna.
    const prod = await executeKw(
      "product.product", "search_read",
      [[["default_code", "=", GENERIC_REF]]],
      { fields: ["id"], limit: 1 }
    );
    if (!prod || prod.length === 0) {
      return json({
        ok: false,
        needsProduct: true,
        error: `No encontré el producto genérico en Odoo. Crea un producto con la referencia interna exacta "${GENERIC_REF}" (tipo Servicio o Consumible) y vuelve a intentar.`,
      }, 400);
    }
    const productId = prod[0].id;

    // 1b) Conexiones: si la línea trae "sku" (código STROBBE), usa el producto
    // REAL de Odoo (match por referencia interna). Así descuenta inventario y
    // reporta por SKU. Si el código no existe en Odoo, cae al genérico.
    const skus = [...new Set(lines.filter((l) => l && l.sku).map((l) => String(l.sku)))];
    const bySku = {};
    if (skus.length) {
      const found = await executeKw(
        "product.product", "search_read",
        [[["default_code", "in", skus]]],
        { fields: ["id", "default_code"] }
      ).catch(() => []);
      (found || []).forEach((p) => { bySku[p.default_code] = p.id; });
    }

    // 2) Arma las líneas de la cotización.
    const orderLines = lines
      .filter((l) => l && l.name)
      .map((l) => [0, 0, {
        product_id: (l.sku && bySku[String(l.sku)]) || productId,
        name: String(l.name),
        product_uom_qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
        price_unit: Number(l.price) || 0,
      }]);

    if (body.note) {
      // Nota visible como sección al inicio (opcional).
      orderLines.unshift([0, 0, { display_type: "line_note", name: String(body.note) }]);
    }

    // 3) Crea la cotización (queda en borrador; NO se confirma ni se envía).
    const orderId = await executeKw("sale.order", "create", [{
      partner_id: partnerId,
      order_line: orderLines,
    }]);

    // 4) Lee el folio para mostrarlo.
    const read = await executeKw("sale.order", "read", [[orderId], ["name"]]);
    const folio = read && read[0] ? read[0].name : String(orderId);

    const base = (process.env.ODOO_URL || "").replace(/\/+$/, "");
    const link = `${base}/web#id=${orderId}&model=sale.order&view_type=form`;

    // 4b) Aviso por correo a administración (con copia a dirección) para revisión.
    try {
      const destino = (process.env.COTIZA_CORREO_ADMIN || "").trim();
      const copia = (process.env.COTIZA_CORREO_DIRECCION || "").trim();
      if (destino || copia) {
        const cli = await executeKw("res.partner", "read", [[partnerId], ["name"]]).catch(() => [{ name: "Cliente" }]);
        const nombreCli = (cli && cli[0] && cli[0].name) || "Cliente";
        const mxn = (n) => "$" + (Number(n) || 0).toLocaleString("es-MX", { minimumFractionDigits: 2 });
        const total = lines.reduce((a, l) => a + (Number(l.price) || 0) * (Number(l.qty) > 0 ? Number(l.qty) : 1), 0);
        const filas = lines.map((l) => {
          const q = Number(l.qty) > 0 ? Number(l.qty) : 1;
          const td = 'padding:7px 10px;border-bottom:1px solid #eceef4;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1b2138;';
          return '<tr><td style="' + td + '">' + String(l.name).replace(/</g, "&lt;") + '</td><td align="center" style="' + td + '">' + q + '</td><td align="right" style="' + td + '">' + mxn(l.price) + '</td><td align="right" style="' + td + 'font-weight:bold;">' + mxn((Number(l.price) || 0) * q) + '</td></tr>';
        }).join("");
        const th = 'padding:7px 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#8a93a8;border-bottom:2px solid #e6e9f0;';
        const html = '<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;">' +
          '<div style="background:#141829;border-bottom:3px solid #263370;padding:16px 20px;color:#ffffff;font-weight:bold;font-size:16px;">Nueva cotización de mangueras — revisar</div>' +
          '<div style="background:#ffffff;border:1px solid #e6e9f0;padding:18px 20px;">' +
          '<p style="font-size:14px;color:#1b2138;margin:0 0 4px;"><b>' + folio + '</b> · ' + nombreCli.replace(/</g, "&lt;") + '</p>' +
          '<p style="font-size:13px;color:#46506a;margin:0 0 14px;">' + String(body.note || "").replace(/</g, "&lt;") + '</p>' +
          '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
          '<tr><th align="left" style="' + th + '">DESCRIPCIÓN</th><th style="' + th + '">CANT.</th><th align="right" style="' + th + '">P. UNIT</th><th align="right" style="' + th + '">IMPORTE</th></tr>' +
          filas +
          '<tr><td colspan="3" align="right" style="padding:10px;font-family:Arial;font-size:13px;font-weight:bold;">TOTAL</td><td align="right" style="padding:10px;font-family:Arial;font-size:15px;font-weight:bold;color:#3a52a8;">' + mxn(total) + '</td></tr>' +
          '</table>' +
          '<p style="margin:16px 0 0;"><a href="' + link + '" style="background:#3a52a8;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:13px;font-weight:bold;display:inline-block;">Abrir cotización en Odoo</a></p>' +
          '<p style="font-size:11px;color:#8a93a8;margin-top:14px;">La cotización quedó en BORRADOR. Revísala antes de enviarla al cliente.</p>' +
          '</div></div>';
        const vals = { subject: `📋 Cotización ${folio} · ${nombreCli} · ${mxn(total)}`, body_html: html, email_to: destino || copia, auto_delete: false };
        if (destino && copia && copia !== destino) vals.email_cc = copia;
        const mailId = await executeKw("mail.mail", "create", [vals]);
        await executeKw("mail.mail", "send", [[mailId]]).catch(() => {});
      }
    } catch (e) { console.error("Aviso de cotización falló:", e); }

    return json({ ok: true, orderId, folio, link });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
