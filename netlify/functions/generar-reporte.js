// netlify/functions/generar-reporte.js
// POST /api/generar-reporte
// Body: { raw, cliente, orden, fecha, tecnicos:[], equipo, planta, images:[dataURL] }
// Devuelve el reporte estructurado en tarjetas para la plantilla:
//   hallazgos[], actividades[], plan[]  (+ tipo_servicio, equipo, cta)
//
// IA GRATUITA por defecto: Google Gemini (Flash). Key gratis en aistudio.google.com -> GEMINI_API_KEY
// Alternativas: GROQ_API_KEY (gratis, no entrena) o ANTHROPIC_API_KEY.
import { checkToken, json } from "./lib/odoo.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM = `Eres un asistente técnico de HydraTech / Tube-Mac, empresa de servicio hidráulico industrial en México.
A partir de notas crudas del técnico (texto escrito o dictado) y, si las hay, fotos del trabajo, redactas un REPORTE DE SERVICIO claro, profesional y presentable en español de México, corrigiendo ortografía y redacción.
El reporte SIEMPRE tiene tres secciones, cada una como una LISTA de puntos:
1) HALLAZGOS: lo que se encontró / diagnóstico. Cada hallazgo con severidad.
2) ACTIVIDADES: el trabajo realizado para reparar. Cada actividad indica si fue solución definitiva o provisional.
3) PLAN: recomendaciones de seguimiento y refacciones/componentes a cambiar (orientado a generar más venta), cada una con prioridad y urgencia.
Reglas:
- No inventes datos que no estén en las notas o imágenes.
- Terminología hidráulica correcta (mangueras, conexiones, presiones, sellos, válvulas, bombas, etc.).
- Breve, concreto, tercera persona, tono profesional.
- Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni markdown, con esta forma EXACTA:
{
 "tipo_servicio": "texto corto, ej. Reparación + recalibración",
 "equipo": "equipo intervenido si se menciona, si no cadena vacía",
 "hallazgos": [ {"titulo":"...","descripcion":"...","severidad":"critica|atencion|normal"} ],
 "actividades": [ {"titulo":"...","descripcion":"...","estado":"definitivo|provisional"} ],
 "plan": [ {"titulo":"...","descripcion":"...","prioridad":"alta|media|baja","urgencia":"0-15 días|1-2 meses|6 meses"} ],
 "cta_titulo": "siguiente paso de venta recomendado, una línea",
 "cta_texto": "una frase breve invitando a agendar/cotizar"
}`;

function parseImages(images) {
  const out = [];
  for (const img of images || []) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(img || "");
    if (m) out.push({ mime: m[1], data: m[2] });
  }
  return out;
}
function cleanJson(text) {
  let t = (text || "").replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); }
  catch (e) {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) {} }
    return null;
  }
}
function normalize(r) {
  r = r && typeof r === "object" ? r : {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const card = (c) => (typeof c === "string" ? { titulo: c, descripcion: "" } : (c || {}));
  return {
    tipo_servicio: r.tipo_servicio || "",
    equipo: r.equipo || "",
    hallazgos: arr(r.hallazgos).map(card),
    actividades: arr(r.actividades).map(card),
    plan: arr(r.plan).map(card),
    cta_titulo: r.cta_titulo || "Siguiente paso recomendado",
    cta_texto: r.cta_texto || "",
  };
}

async function callGemini(userText, imgs) {
  const parts = [{ text: userText }];
  for (const im of imgs) parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2200, responseMimeType: "application/json" },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Error de Gemini");
  return cleanJson((data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""));
}
async function callGroq(userText) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL, temperature: 0.3, response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userText }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Error de Groq");
  return cleanJson(data.choices?.[0]?.message?.content || "");
}
async function callAnthropic(userText, imgs) {
  const content = [{ type: "text", text: userText }];
  for (const im of imgs) content.push({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data } });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2200, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Error de Anthropic");
  return cleanJson((data.content || []).map((b) => b.text || "").join(""));
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Usa POST." }, 405);
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);

  const provider = GEMINI_API_KEY ? "gemini" : GROQ_API_KEY ? "groq" : ANTHROPIC_API_KEY ? "anthropic" : null;
  if (!provider) return json({ ok: false, error: "Falta configurar una IA. Agrega GEMINI_API_KEY (gratis en aistudio.google.com) en Netlify." }, 500);

  try {
    const body = await req.json();
    const hn = (body.hallazgos_notas || "").toString().trim();
    const an = (body.actividades_notas || "").toString().trim();
    const pn = (body.plan_notas || "").toString().trim();
    const raw = (body.raw || "").toString().trim();
    const imgs = parseImages(body.images);
    if (!hn && !an && !pn && !raw && !imgs.length) return json({ ok: false, error: "Faltan las notas del técnico (texto o dictado)." }, 400);

    const cliente = body.cliente || "", orden = body.orden || "";
    const fecha = body.fecha || new Date().toISOString().slice(0, 10);
    const equipo = body.equipo || "", planta = body.planta || "", tipo = body.tipo || "";
    const tecnicos = Array.isArray(body.tecnicos) ? body.tecnicos.filter(Boolean) : [];

    const notas = (hn || an || pn)
      ? `[HALLAZGOS / cómo se encontró]\n${hn || "(sin notas)"}\n\n[ACTIVIDADES REALIZADAS]\n${an || "(sin notas)"}\n\n[PLAN DE ACCIÓN / pendientes]\n${pn || "(sin notas)"}`
      : raw;

    const userText =
      `Contexto:\n- Cliente: ${cliente || "(de la orden)"}\n- Orden: ${orden || "(n/d)"}\n- Fecha: ${fecha}\n` +
      `- Planta/Ubicación: ${planta || "(n/d)"}\n- Tipo de servicio: ${tipo || "(n/d)"}\n- Técnicos: ${tecnicos.join(", ") || "(n/d)"}\n\n` +
      `Notas del técnico:\n${notas}`;

    let parsed;
    if (provider === "gemini") parsed = await callGemini(userText, imgs);
    else if (provider === "groq") parsed = await callGroq(userText);
    else parsed = await callAnthropic(userText, imgs);

    const report = normalize(parsed);
    return json({ ok: true, provider, report });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
