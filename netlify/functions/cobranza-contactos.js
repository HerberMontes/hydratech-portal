// netlify/functions/cobranza-contactos.js
// DIRECTORIO DE COBRANZA por cliente — independiente de los contactos de Odoo
// (que suelen ser genéricos). Guarda en el propio cliente (res.partner) el
// adjunto portal_cobranza_contactos.json con:
//   { contactos: [ { nombre, correo, whatsapp, nivel } ] }
//   nivel: "raso" | "supervisor" | "cxp"
// Matriz de escalamiento que usa el motor:
//   SolPed -> raso · OC -> raso+supervisor · Pago -> raso+supervisor+cxp
//
//   GET  ?q=texto        -> buscar clientes por nombre (para el selector)
//   GET  ?partnerId=NN   -> leer directorio del cliente
//   POST { partnerId, contactos: [...] } -> guardar
import { executeKw, checkToken, json } from "./lib/odoo.js";

const NOMBRE = "portal_cobranza_contactos.json";
const NIVELES = ["raso", "supervisor", "cxp"];

async function attDe(partnerId) {
  const found = await executeKw("ir.attachment", "search_read",
    [[["res_model", "=", "res.partner"], ["res_id", "=", partnerId], ["name", "=", NOMBRE]]],
    { fields: ["id", "datas"], limit: 1 });
  if (!found.length) return { attId: null, data: { contactos: [] } };
  let data = { contactos: [] };
  try { data = JSON.parse(Buffer.from(found[0].datas || "", "base64").toString("utf8")) || data; } catch (e) {}
  if (!Array.isArray(data.contactos)) data.contactos = [];
  return { attId: found[0].id, data };
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    if (req.method === "GET") {
      const u = new URL(req.url);
      const q = (u.searchParams.get("q") || "").trim();
      const partnerId = parseInt(u.searchParams.get("partnerId") || 0, 10);
      if (partnerId) {
        const { data } = await attDe(partnerId);
        return json({ ok: true, partnerId, contactos: data.contactos });
      }
      if (q) {
        const parts = await executeKw("res.partner", "search_read",
          [["&", ["parent_id", "=", false], ["name", "ilike", q]]],
          { fields: ["id", "name", "city"], limit: 12 });
        return json({ ok: true, clientes: parts.map((p) => ({ id: p.id, name: p.name, city: p.city || "" })) });
      }
      return json({ ok: false, error: "Falta q o partnerId." }, 400);
    }

    if (req.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);
    const body = await req.json().catch(() => ({}));
    const partnerId = parseInt(body.partnerId || 0, 10);
    if (!partnerId) return json({ ok: false, error: "Falta partnerId." }, 400);

    // Sanitizar: nombre requerido; correo o whatsapp al menos uno; nivel válido
    const contactos = (Array.isArray(body.contactos) ? body.contactos : []).map((c) => ({
      nombre: String(c.nombre || "").trim().slice(0, 120),
      correo: String(c.correo || "").trim().toLowerCase().slice(0, 160),
      whatsapp: String(c.whatsapp || "").replace(/\D/g, "").slice(0, 15),
      nivel: NIVELES.includes(c.nivel) ? c.nivel : "raso",
    })).filter((c) => c.nombre && (c.correo || c.whatsapp));
    for (const c of contactos) {
      if (c.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.correo)) return json({ ok: false, error: `Correo no válido: ${c.correo}` }, 400);
      if (c.whatsapp && c.whatsapp.length < 12) return json({ ok: false, error: `WhatsApp incompleto (usa 521 + 10 dígitos): ${c.whatsapp}` }, 400);
    }

    const { attId } = await attDe(partnerId);
    const datas = Buffer.from(JSON.stringify({ contactos, updatedAt: new Date().toISOString() })).toString("base64");
    if (attId) await executeKw("ir.attachment", "write", [[attId], { datas }]);
    else await executeKw("ir.attachment", "create", [{ name: NOMBRE, res_model: "res.partner", res_id: partnerId, type: "binary", mimetype: "application/json", datas }]);
    await executeKw("res.partner", "message_post", [[partnerId]], { body: `Directorio de cobranza actualizado (${contactos.length} contactos).` }).catch(() => {});
    return json({ ok: true, guardados: contactos.length });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
