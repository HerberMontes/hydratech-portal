// netlify/functions/odoo-products.js
// GET /api/odoo-products?q=texto&limit=50
// Devuelve productos de Odoo con su precio de venta y costo.
import { executeKw, checkToken, json } from "./lib/odoo.js";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);

    // Busca por nombre o por código interno (default_code)
    const domain = q
      ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]]
      : [];

    const products = await executeKw(
      "product.product", "search_read", [domain],
      { fields: ["id", "default_code", "name", "list_price", "standard_price", "uom_id"], limit, order: "default_code" }
    );

    return json({ ok: true, count: products.length, products });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
