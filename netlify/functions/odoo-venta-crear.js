// netlify/functions/odoo-venta-crear.js
// CREAR COTIZACIÓN / ORDEN desde el portal, directo en Odoo (sale.order).
//
//   GET  /api/odoo-venta-crear?cliente=ID
//        -> detalle para el formulario: RFC, términos de pago disponibles y el
//           término por defecto del cliente.
//   POST /api/odoo-venta-crear
//        Body: { tipo: "cotizacion"|"orden", partnerId, terminoId, tiempoEntrega,
//                vendedor, lineas:[{productId?, desc, qty, precio}],
//                oc?, vigencia?, entregaFecha?, notas? }
//        -> crea la sale.order (borrador u orden confirmada) y regresa el folio.
//
// REGLA DE CALIDAD DE DATOS: no se guarda nada incompleto en Odoo. Obligatorios:
// cliente, términos de pago, TIEMPO DE ENTREGA, vendedor y al menos una línea
// completa (descripción + cantidad > 0 + precio válido). La OC / referencia del
// cliente es OPCIONAL (no siempre se tiene al cotizar); se captura después.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const GENERIC_REF = process.env.VENTA_PRODUCTO_GENERICO || "MANG-ARMADA"; // para líneas de descripción libre
const DESDE = process.env.REPORTES_DESDE || ""; // corte: solo cotizaciones de esta fecha en adelante
const vendTag = (n) => "Vendedor · " + String(n || "").trim();

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  const url = new URL(req.url);

  /* ---------- GET ?cotizaciones=1: borradores abiertos en Odoo ---------- */
  if (req.method === "GET" && url.searchParams.get("cotizaciones") === "1") {
    try {
      // Solo cotizaciones del corte en adelante (REPORTES_DESDE en Netlify);
      // lo anterior a esa fecha es historia y no debe reactivarse desde aquí.
      const dominio = DESDE
        ? [["state", "in", ["draft", "sent"]], ["date_order", ">=", DESDE + " 00:00:00"]]
        : [["state", "in", ["draft", "sent"]]];
      const rows = await executeKw("sale.order", "search_read",
        [dominio],
        { fields: ["id", "name", "partner_id", "date_order", "amount_total", "state", "validity_date"],
          order: "date_order desc", limit: 40 });
      const base = (process.env.ODOO_URL || "").replace(/\/+$/, "");
      return json({
        ok: true,
        cotizaciones: rows.map((o) => ({
          id: o.id, folio: o.name,
          cliente: Array.isArray(o.partner_id) ? o.partner_id[1] : "—",
          fecha: String(o.date_order || "").slice(0, 10),
          total: o.amount_total || 0,
          estado: o.state === "sent" ? "Enviada" : "Borrador",
          vigencia: o.validity_date || "",
          link: base ? base + "/web#id=" + o.id + "&model=sale.order&view_type=form" : "",
        })),
      });
    } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
  }

  /* ---------- GET: detalle del cliente para el formulario ---------- */
  if (req.method === "GET") {
    const pid = Number(url.searchParams.get("cliente") || 0);
    if (!pid) return json({ ok: false, error: "Falta ?cliente=ID" }, 400);
    try {
      const [p] = await executeKw("res.partner", "read",
        [[pid], ["name", "vat", "property_payment_term_id"]]);
      if (!p) return json({ ok: false, error: "Cliente no encontrado." }, 404);
      const terminos = await executeKw("account.payment.term", "search_read",
        [[]], { fields: ["id", "name"], order: "name", limit: 100 }).catch(() => []);
      return json({
        ok: true,
        cliente: p.name,
        rfc: p.vat || "—",
        terminoDefault: Array.isArray(p.property_payment_term_id) ? p.property_payment_term_id[0] : null,
        terminos: terminos.map((t) => ({ id: t.id, name: t.name })),
      });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  if (req.method !== "POST") return json({ ok: false, error: "Usa GET o POST." }, 405);

  /* ---------- POST: crear la cotización / orden ---------- */
  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: "JSON inválido." }, 400); }

  /* ---------- Convertir una cotización existente en ORDEN DE VENTA ---------- */
  if (b && b.action === "confirmar") {
    const oid = Number(b.orderId) || 0;
    if (!oid) return json({ ok: false, error: "Falta orderId." }, 400);
    try {
      const [o] = await executeKw("sale.order", "read", [[oid], ["name", "state"]]);
      if (!o) return json({ ok: false, error: "Cotización no encontrada." }, 404);
      if (o.state === "sale" || o.state === "done")
        return json({ ok: true, folio: o.name, yaEraOrden: true });
      if (o.state === "cancel")
        return json({ ok: false, error: "La cotización " + o.name + " está cancelada en Odoo." }, 400);
      await executeKw("sale.order", "action_confirm", [[oid]]);
      return json({ ok: true, folio: o.name, confirmada: true });
    } catch (e) {
      return json({ ok: false, error: "Odoo no permitió confirmarla: " + String(e.message || e) }, 500);
    }
  }

  // ----- Validación estricta en servidor (espejo de la del formulario) -----
  const faltan = [];
  const tipo = b.tipo === "orden" ? "orden" : "cotizacion";
  const partnerId = Number(b.partnerId) || 0;
  const terminoId = Number(b.terminoId) || 0;
  const tiempoEntrega = String(b.tiempoEntrega || "").trim();
  const vendedor = String(b.vendedor || "").trim();
  const oc = String(b.oc || "").trim(); // OPCIONAL a propósito
  const lineasIn = Array.isArray(b.lineas) ? b.lineas : [];
  const lineas = lineasIn
    .map((l) => ({
      productId: Number(l.productId) || 0,
      desc: String(l.desc || "").trim(),
      qty: Number(l.qty),
      precio: Number(l.precio),
    }))
    .filter((l) => l.desc || l.qty || l.precio); // ignora renglones totalmente vacíos

  if (!partnerId) faltan.push("cliente");
  if (!terminoId) faltan.push("términos de pago");
  if (!tiempoEntrega) faltan.push("tiempo de entrega");
  if (!vendedor) faltan.push("vendedor");
  if (!lineas.length) faltan.push("al menos una línea de producto");
  const lineasMal = lineas.filter((l) => !l.desc || !(l.qty > 0) || !(l.precio >= 0) || isNaN(l.precio));
  if (lineas.length && lineasMal.length) faltan.push("líneas completas (descripción, cantidad > 0 y precio)");
  if (faltan.length) {
    return json({ ok: false, error: "Faltan datos obligatorios: " + faltan.join(", ") + "." }, 400);
  }

  try {
    // ----- Producto genérico para líneas de descripción libre -----
    const necesitaGenerico = lineas.some((l) => !l.productId);
    let genericId = 0;
    if (necesitaGenerico) {
      const prod = await executeKw("product.product", "search_read",
        [[["default_code", "=", GENERIC_REF]]], { fields: ["id"], limit: 1 });
      if (!prod || !prod.length) {
        return json({ ok: false, error: 'Para líneas de descripción libre se necesita en Odoo un producto con referencia interna "' + GENERIC_REF + '". Créalo una vez (tipo Servicio o Consumible) o usa solo productos del catálogo.' }, 400);
      }
      genericId = prod[0].id;
    }

    // ----- Etiqueta del vendedor (misma convención que el CRM) -----
    let tagId = 0;
    try {
      const tg = await executeKw("crm.tag", "search_read",
        [[["name", "=", vendTag(vendedor)]]], { fields: ["id"], limit: 1 });
      tagId = (tg && tg.length) ? tg[0].id : await executeKw("crm.tag", "create", [{ name: vendTag(vendedor) }]);
    } catch (e) {}

    // ----- Armar la orden -----
    const nota = "Tiempo de entrega: " + tiempoEntrega + (b.notas ? "\n" + String(b.notas).trim() : "");
    const vals = {
      partner_id: partnerId,
      payment_term_id: terminoId,
      note: nota,
      order_line: lineas.map((l) => [0, 0, {
        product_id: l.productId || genericId,
        name: l.desc,
        product_uom_qty: l.qty,
        price_unit: l.precio,
      }]),
    };
    if (oc) vals.client_order_ref = oc;
    if (b.vigencia && tipo === "cotizacion") vals.validity_date = String(b.vigencia).slice(0, 10);
    if (b.entregaFecha) vals.commitment_date = String(b.entregaFecha).slice(0, 10) + " 12:00:00";
    if (tagId) vals.tag_ids = [[4, tagId]];

    const orderId = await executeKw("sale.order", "create", [vals]);

    // ----- Confirmar si es orden -----
    let confirmada = false, avisoConfirmacion = "";
    if (tipo === "orden") {
      try { await executeKw("sale.order", "action_confirm", [[orderId]]); confirmada = true; }
      catch (e) { avisoConfirmacion = "Se creó como borrador; Odoo no permitió confirmarla automáticamente: " + String(e.message || e); }
    }

    const [read] = await executeKw("sale.order", "read", [[orderId], ["name"]]);
    const base = (process.env.ODOO_URL || "").replace(/\/+$/, "");
    return json({
      ok: true,
      id: orderId,
      folio: read ? read.name : "S?",
      confirmada,
      avisoConfirmacion: avisoConfirmacion || undefined,
      link: base ? base + "/web#id=" + orderId + "&model=sale.order&view_type=form" : "",
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
