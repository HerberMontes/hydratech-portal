// netlify/functions/cobranza-migrar.js
// MIGRACIÓN ÚNICA del seguimiento de cobranza al corte del Excel "SEGUIMIENTO.xlsx"
// (5 jul 2026). Actualiza el portal_cobranza.json de cada orden para que el
// flujo (Evidencia → SOLPED → Esperando OC → Acuse/Por pagar → Pagado) refleje
// el estatus real del Excel, no el seguimiento anterior.
//
// USO (con sesión iniciada):
//   GET /api/cobranza-migrar               -> VISTA PREVIA (no cambia nada)
//   GET /api/cobranza-migrar?confirmar=1   -> APLICA los cambios en Odoo
//
// Mapeo de ESTATUS del Excel al flujo:
//   EVIDENCIA "PENDIENTE SOLPED"  -> limpia solped/oc/pago  => paso SOLPED
//   SOLPED n  "PENDIENTE DE OC"   -> solped=n               => paso Esperando OC
//   OC n      "POR AUTORIZAR"     -> oc="n · por autorizar" => paso Acuse (esperando ingresar factura)
//   ACUSE n   "POR PAGAR"         -> oc/solped (histórico), acuse migrado con folio n
//                                    => paso Por pagar (corre el crédito desde hoy)
//   PAGADO n                      -> pago{ref:n, complemento:true} => paso Pagado
//   (vacío)   "SIN REGISTRO"      -> limpia todo => arranca el flujo desde el inicio
// Los relojes de pasos ya alcanzados se fijan a la fecha de la migración si no
// había fecha previa (el Excel no trae fechas).
import { executeKw, checkToken, json } from "./lib/odoo.js";

const ATT = "portal_cobranza.json";
const ACUSE_PREFIX = "portal_acuse";
const hoy = () => new Date().toISOString().slice(0, 10);

const TABLA = [
  {
    "folio": "S00082",
    "estatus": "OC",
    "num": "4500621108",
    "comentario": "POR AUTORIZAR"
  },
  {
    "folio": "S00579",
    "estatus": "SOLPED",
    "num": "13442538 POS 30",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01023",
    "estatus": "SOLPED",
    "num": "13594498 pos 10",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01048",
    "estatus": "SOLPED",
    "num": "23545",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01075",
    "estatus": "SOLPED",
    "num": "24141",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01096",
    "estatus": "SOLPED",
    "num": "24271",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01122",
    "estatus": "SOLPED",
    "num": "24124",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01189",
    "estatus": "SOLPED",
    "num": "24125",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01196",
    "estatus": "SOLPED",
    "num": "24125",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01256",
    "estatus": "SOLPED",
    "num": "24271",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01339",
    "estatus": "SOLPED",
    "num": "23421",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01362",
    "estatus": "SOLPED",
    "num": "25280",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01377",
    "estatus": "SOLPED",
    "num": "25285",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01528",
    "estatus": "SOLPED",
    "num": "25475",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01527",
    "estatus": "SOLPED",
    "num": "25477",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01526",
    "estatus": "SOLPED",
    "num": "25477",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01525",
    "estatus": "SOLPED",
    "num": "25476",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01524",
    "estatus": "SOLPED",
    "num": "25478",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01523",
    "estatus": "SOLPED",
    "num": "25478",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01522",
    "estatus": "SOLPED",
    "num": "25478",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01521",
    "estatus": "SOLPED",
    "num": "25473",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01535",
    "estatus": "SOLPED",
    "num": "26891",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01548",
    "estatus": "SOLPED",
    "num": "27228",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01550",
    "estatus": "SOLPED",
    "num": "26888",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01583",
    "estatus": "SOLPED",
    "num": "25581",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01637",
    "estatus": "SOLPED",
    "num": "26105",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01664",
    "estatus": "SOLPED",
    "num": "27142",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01706",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01740",
    "estatus": "ACUSE",
    "num": "45987",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01739",
    "estatus": "ACUSE",
    "num": "45988",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01741",
    "estatus": "ACUSE",
    "num": "47765",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01776",
    "estatus": "ACUSE",
    "num": "57267",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01779",
    "estatus": "ACUSE",
    "num": "59802",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01788",
    "estatus": "ACUSE",
    "num": "59800",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01781",
    "estatus": "ACUSE",
    "num": "130128",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01796",
    "estatus": "ACUSE",
    "num": "49387",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01834",
    "estatus": "ACUSE",
    "num": "131088",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01841",
    "estatus": "PAGADO",
    "num": "131376",
    "comentario": ""
  },
  {
    "folio": "S01913",
    "estatus": "ACUSE",
    "num": "54924",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01910",
    "estatus": "ACUSE",
    "num": "54923",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01914",
    "estatus": "ACUSE",
    "num": "54989 Y 54923",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01915",
    "estatus": "ACUSE",
    "num": "55318",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01923",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01925",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01918",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01858",
    "estatus": "ACUSE",
    "num": "55530 Y 55731",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01819",
    "estatus": "ACUSE",
    "num": "55530",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01860",
    "estatus": "ACUSE",
    "num": "55390",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01843",
    "estatus": "ACUSE",
    "num": "55286",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01811",
    "estatus": "ACUSE",
    "num": "55287",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01920",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01930",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01935",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01934",
    "estatus": "ACUSE",
    "num": "580",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01818",
    "estatus": "SOLPED",
    "num": "47854",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01986",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01980",
    "estatus": "ACUSE",
    "num": "714",
    "comentario": "POR PAGAR"
  },
  {
    "folio": "S01988",
    "estatus": "EVIDENCIA",
    "num": "",
    "comentario": "PENDIENTE SOLPED"
  },
  {
    "folio": "S01989",
    "estatus": "SIN",
    "num": "",
    "comentario": "SIN REGISTRO"
  },
  {
    "folio": "S01183",
    "estatus": "SOLPED",
    "num": "48475",
    "comentario": "PENDIENTE DE OC"
  },
  {
    "folio": "S01992",
    "estatus": "SIN",
    "num": "",
    "comentario": "SIN REGISTRO"
  }
];

function planDe(fila, prev) {
  const d = { ...prev };
  const est = fila.estatus;
  const n = String(fila.num || "").trim();
  const marca = (v) => v && String(v).trim();

  if (est === "SIN" || !est) {
    d.solped = ""; d.oc = ""; d.pago = null; d.acuseFecha = "";
    return { d, esperado: "Inicio del flujo (según evidencia)", acuseTxt: null };
  }
  if (est === "EVIDENCIA") {
    d.solped = ""; d.oc = ""; d.pago = null; d.acuseFecha = "";
    return { d, esperado: "SOLPED (pendiente de ingresar solped)", acuseTxt: null };
  }
  if (est === "SOLPED") {
    d.solped = n || "(histórico)";
    if (!marca(d.solpedFecha)) d.solpedFecha = hoy();
    d.oc = ""; d.pago = null; d.acuseFecha = "";
    return { d, esperado: "Esperando OC", acuseTxt: null };
  }
  if (est === "OC") {
    if (!marca(d.solped)) d.solped = "(histórico)";
    if (!marca(d.solpedFecha)) d.solpedFecha = hoy();
    d.oc = n ? (n + (fila.comentario && /autorizar/i.test(fila.comentario) ? " · por autorizar" : "")) : "(histórico)";
    if (!marca(d.ocFecha)) d.ocFecha = hoy();
    d.pago = null; d.acuseFecha = "";
    return { d, esperado: "Acuse (esperando ingresar factura)", acuseTxt: null };
  }
  if (est === "ACUSE") {
    if (!marca(d.solped)) d.solped = "(histórico)";
    if (!marca(d.solpedFecha)) d.solpedFecha = hoy();
    if (!marca(d.oc)) d.oc = "(histórico)";
    if (!marca(d.ocFecha)) d.ocFecha = hoy();
    if (!marca(d.acuseFecha)) d.acuseFecha = hoy();
    if (n) d.acuseFolio = n;
    d.pago = null;
    return { d, esperado: "Por pagar (crédito corriendo desde el acuse)",
      acuseTxt: "Acuse migrado del seguimiento (5 jul 2026)" + (n ? " · Folio: " + n : "") };
  }
  if (est === "PAGADO") {
    if (!marca(d.solped)) d.solped = "(histórico)";
    if (!marca(d.oc)) d.oc = "(histórico)";
    if (!marca(d.acuseFecha)) d.acuseFecha = hoy();
    if (n) d.acuseFolio = n;
    d.pago = { fecha: (d.pago && d.pago.fecha) || hoy(), ref: n || ((d.pago && d.pago.ref) || ""), complemento: true };
    return { d, esperado: "Pagado",
      acuseTxt: "Acuse migrado del seguimiento (5 jul 2026)" + (n ? " · Folio: " + n : "") };
  }
  return { d, esperado: "(estatus no reconocido: " + est + ")", acuseTxt: null };
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  const url = new URL(req.url);
  const confirmar = url.searchParams.get("confirmar") === "1";
  try {
    // 1) Localizar las órdenes por folio
    const folios = TABLA.map((f) => f.folio);
    const orders = await executeKw("sale.order", "search_read",
      [[["name", "in", folios]]], { fields: ["id", "name", "partner_id"], limit: 300 });
    const porFolio = Object.fromEntries(orders.map((o) => [o.name, o]));
    const noEncontradas = folios.filter((f) => !porFolio[f]);

    // 2) Leer los JSON de cobranza existentes de un jalón
    const ids = orders.map((o) => o.id);
    const atts = ids.length ? await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "in", ids], ["name", "=", ATT]]],
      { fields: ["id", "res_id", "datas"], limit: 500 }) : [];
    const attByOrder = {};
    atts.forEach((a) => { attByOrder[a.res_id] = a; });
    const acuses = ids.length ? await executeKw("ir.attachment", "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "in", ids], ["name", "like", ACUSE_PREFIX + "%"]]],
      { fields: ["id", "res_id"], limit: 500 }) : [];
    const tieneAcuse = new Set(acuses.map((a) => a.res_id));

    // 3) Armar el plan por orden
    const plan = [];
    for (const fila of TABLA) {
      const o = porFolio[fila.folio];
      if (!o) continue;
      let prev = {};
      const ex = attByOrder[o.id];
      if (ex) { try { prev = JSON.parse(Buffer.from(ex.datas || "", "base64").toString("utf8")); } catch (e) {} }
      const { d, esperado, acuseTxt } = planDe(fila, prev);
      plan.push({
        folio: fila.folio, id: o.id,
        cliente: Array.isArray(o.partner_id) ? o.partner_id[1] : "",
        estatusExcel: fila.estatus + (fila.num ? " " + fila.num : ""),
        comentarioExcel: fila.comentario,
        pasoEsperado: esperado,
        cambios: { solped: d.solped, oc: d.oc, acuseFecha: d.acuseFecha || "", pago: d.pago || null, acuseFolio: d.acuseFolio || "" },
        _data: d, _attId: ex ? ex.id : null,
        _crearAcuse: !!acuseTxt && !tieneAcuse.has(o.id),
        _acuseTxt: acuseTxt,
      });
    }

    if (!confirmar) {
      return json({
        ok: true,
        modo: "VISTA PREVIA — no se cambió nada",
        totalExcel: TABLA.length,
        encontradas: plan.length,
        noEncontradasEnOdoo: noEncontradas,
        instruccion: "Si el plan es correcto, agrega ?confirmar=1 para aplicarlo.",
        plan: plan.map(({ _data, _attId, _crearAcuse, _acuseTxt, ...p }) => p),
      });
    }

    // 4) Aplicar: escribir el JSON de cobranza (y el acuse migrado si aplica)
    let actualizadas = 0, acusesCreados = 0;
    for (const p of plan) {
      const datas = Buffer.from(JSON.stringify(p._data)).toString("base64");
      if (p._attId) await executeKw("ir.attachment", "write", [[p._attId], { datas }]);
      else await executeKw("ir.attachment", "create", [{
        name: ATT, res_model: "sale.order", res_id: p.id,
        type: "binary", mimetype: "application/json", datas,
      }]);
      if (p._crearAcuse) {
        await executeKw("ir.attachment", "create", [{
          name: ACUSE_PREFIX + "_migrado.txt", res_model: "sale.order", res_id: p.id,
          type: "binary", mimetype: "text/plain",
          datas: Buffer.from(p._acuseTxt, "utf8").toString("base64"),
        }]);
        acusesCreados++;
      }
      actualizadas++;
    }
    return json({ ok: true, actualizadas, acusesCreados, noEncontradasEnOdoo: noEncontradas });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
