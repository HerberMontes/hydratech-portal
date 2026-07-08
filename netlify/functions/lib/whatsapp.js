// netlify/functions/lib/whatsapp.js
// Helpers de WhatsApp Cloud API (Meta). Variables de entorno:
//   WHATSAPP_TOKEN     -> token permanente del sistema (Meta Business)
//   WHATSAPP_PHONE_ID  -> id del número de teléfono (no el número, el ID)
//   WHATSAPP_VERIFY    -> palabra secreta que tú inventas para verificar el webhook

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const GRAPH = "https://graph.facebook.com/v20.0";

async function post(payload) {
  const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error("WhatsApp error:", JSON.stringify(data));
  return data;
}

export function enviarTexto(to, body) {
  return post({ messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } });
}

// Botones interactivos (máx 3, títulos de máx 20 caracteres).
export function enviarBotones(to, body, botones) {
  return post({
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "button", body: { text: body },
      action: { buttons: botones.map((b) => ({ type: "reply", reply: { id: b.id, title: b.titulo.slice(0, 20) } })) },
    },
  });
}

// Lista interactiva (máx 10 filas).
export function enviarLista(to, body, tituloBoton, filas) {
  return post({
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list", body: { text: body },
      action: {
        button: tituloBoton.slice(0, 20),
        sections: [{ title: "Opciones", rows: filas.slice(0, 10).map((f) => ({ id: f.id, title: f.titulo.slice(0, 24), description: (f.desc || "").slice(0, 72) })) }],
      },
    },
  });
}

// Descarga un media (audio/imagen) de WhatsApp. Regresa { mime, base64 }.
export async function descargarMedia(mediaId) {
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
  if (!meta.url) throw new Error("No se pudo obtener la URL del media de WhatsApp.");
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!bin.ok) throw new Error("No se pudo descargar el media (" + bin.status + ").");
  const buf = Buffer.from(await bin.arrayBuffer());
  return { mime: meta.mime_type || "application/octet-stream", base64: buf.toString("base64") };
}

// Extrae lo esencial del webhook de Meta. Regresa null si no es un mensaje.
export function leerMensaje(body) {
  try {
    const v = body.entry?.[0]?.changes?.[0]?.value;
    const m = v?.messages?.[0];
    if (!m) return null;
    const out = { de: m.from, id: m.id, tipo: m.type, nombre: v.contacts?.[0]?.profile?.name || "" };
    if (m.type === "text") out.texto = m.text?.body || "";
    if (m.type === "audio") out.mediaId = m.audio?.id;
    if (m.type === "image") { out.mediaId = m.image?.id; out.caption = m.image?.caption || ""; }
    if (m.type === "interactive") {
      const i = m.interactive;
      out.botonId = i?.button_reply?.id || i?.list_reply?.id || "";
      out.texto = i?.button_reply?.title || i?.list_reply?.title || "";
    }
    return out;
  } catch (e) { return null; }
}
