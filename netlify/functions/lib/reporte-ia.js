// netlify/functions/lib/reporte-ia.js
// IA compartida: transcripción de notas de voz y generación del reporte
// estructurado. Usa las MISMAS llaves que generar-reporte.js
// (GEMINI_API_KEY como principal; GROQ_API_KEY para transcribir con Whisper).

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

/* ============ TRANSCRIPCIÓN DE AUDIO ============
   1) Si hay GROQ_API_KEY usa Whisper (rapidísimo y gratis).
   2) Si no, usa Gemini con el audio inline (también entiende ogg/opus de WhatsApp). */
export async function transcribirAudio(mime, base64) {
  if (GROQ_API_KEY) {
    const buf = Buffer.from(base64, "base64");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), "nota.ogg");
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "es");
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: form,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Error de Whisper");
    return (data.text || "").trim();
  }
  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: "Transcribe fielmente este audio en español de México. Responde SOLO con la transcripción, sin comentarios." },
          { inline_data: { mime_type: mime, data: base64 } },
        ] }],
        generationConfig: { temperature: 0 },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Error de Gemini");
    return ((data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("")).trim();
  }
  throw new Error("Configura GROQ_API_KEY o GEMINI_API_KEY para transcribir audios.");
}

/* ============ GENERACIÓN DEL REPORTE ============
   Mismo SYSTEM y mismo JSON de salida que generar-reporte.js, para que el
   borrador que se guarda por WhatsApp sea 100% compatible con el portal. */
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
    tipo_servicio: r.tipo_servicio || "", equipo: r.equipo || "",
    hallazgos: arr(r.hallazgos).map(card), actividades: arr(r.actividades).map(card), plan: arr(r.plan).map(card),
    cta_titulo: r.cta_titulo || "Siguiente paso recomendado", cta_texto: r.cta_texto || "",
  };
}

export async function generarReporteIA({ contexto, notas, images }) {
  if (!GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY.");
  const userText = `Contexto:\n${contexto}\n\nNotas del técnico:\n${notas}`;
  const parts = [{ text: userText }];
  for (const im of images || []) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(im.dataURL || im || "");
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
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
  return normalize(cleanJson((data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("")));
}

/* ============ ESTRUCTURAR "VOZ DEL CLIENTE" ============ */
const SYSTEM_VOZ = `Eres asistente de HydraTech, empresa de servicio hidráulico industrial en México.
Recibes la transcripción de una nota de voz de un técnico o vendedor después de visitar a un cliente.
Estructura la información. Responde SOLO con JSON válido, sin markdown:
{
 "cliente": "nombre del cliente si se menciona, si no cadena vacía",
 "resumen": "resumen de 1-2 líneas de la visita",
 "comentarios_cliente": ["lo que el cliente dijo o pidió (solicitudes neutras)"],
 "quejas": ["quejas, molestias o inconformidades del cliente (separadas de las solicitudes)"],
 "detectado": ["lo que el técnico vio o detectó (fallas, riesgos, faltantes)"],
 "oportunidades": [ {"titulo":"...","descripcion":"...","prioridad":"alta|media|baja"} ]
}`;

export async function estructurarVozCliente(transcripcion) {
  if (!GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_VOZ }] },
      contents: [{ role: "user", parts: [{ text: transcripcion }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1500, responseMimeType: "application/json" },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Error de Gemini");
  const r = cleanJson((data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("")) || {};
  return {
    cliente: r.cliente || "", resumen: r.resumen || "",
    comentarios_cliente: Array.isArray(r.comentarios_cliente) ? r.comentarios_cliente : [],
    quejas: Array.isArray(r.quejas) ? r.quejas : [],
    detectado: Array.isArray(r.detectado) ? r.detectado : [],
    oportunidades: Array.isArray(r.oportunidades) ? r.oportunidades : [],
  };
}
