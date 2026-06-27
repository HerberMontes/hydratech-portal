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

    // 2) Arma las líneas de la cotización.
    const orderLines = lines
      .filter((l) => l && l.name)
      .map((l) => [0, 0, {
        product_id: productId,
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

    return json({ ok: true, orderId, folio, link });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
