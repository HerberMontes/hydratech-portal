// netlify/functions/cobranza-recordatorios.js
// Envoltura HTTP del motor de cobranza (las 3 plantillas de Claude Design).
//   GET  /api/cobranza-recordatorios            -> VISTA PREVIA (no envía)
//   GET  /api/cobranza-recordatorios?enviar=1   -> evalúa cadencia y ENVÍA
//   POST /api/cobranza-recordatorios            -> envío MANUAL a un cliente
//        body: { partnerId, correo }  (ignora cadencia; intención explícita)
// El envío automático diario lo hace cobranza-cron.js (L-V 8:00 am).
import { checkToken, json } from "./lib/odoo.js";
import { correrCobranza } from "./lib/cobranza-motor.js";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.partnerId) return json({ ok: false, error: "Falta partnerId." }, 400);
      const r = await correrCobranza({ enviar: false, manual: { partnerId: body.partnerId, correo: body.correo || "" } });
      return json(r);
    }
    const url = new URL(req.url);
    const enviar = url.searchParams.get("enviar") === "1";
    const r = await correrCobranza({ enviar });
    return json(r);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
