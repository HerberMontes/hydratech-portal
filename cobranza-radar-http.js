// netlify/functions/cobranza-radar-http.js
// Radar de cobranza bajo demanda:
//   GET /api/cobranza-radar-http           -> VER el radar en el navegador (datos vivos)
//   GET /api/cobranza-radar-http?enviar=1  -> además ENVIARLO por correo AHORA
import { checkToken, json } from "./lib/odoo.js";
import { armarRadar, enviarRadar } from "./lib/cobranza-radar.js";

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const u = new URL(req.url);
    if (u.searchParams.get("enviar") === "1") return json(await enviarRadar());
    const { html } = await armarRadar();
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
