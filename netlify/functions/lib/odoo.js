// netlify/functions/lib/odoo.js
// Conector a Odoo por JSON-RPC. Las credenciales se leen de variables de
// entorno (configuradas en Netlify), NUNCA viajan al navegador.

const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, PORTAL_TOKEN } = process.env;

async function jsonrpc(service, method, args) {
  if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY) {
    throw new Error("Faltan variables de entorno de Odoo (ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY).");
  }
  const res = await fetch(`${ODOO_URL.replace(/\/+$/, "")}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(),
      params: { service, method, args } }),
  });
  const data = await res.json();
  if (data.error) {
    const m = data.error.data?.message || data.error.message || "Error de Odoo";
    throw new Error(m);
  }
  return data.result;
}

// Cachea el uid mientras la función esté "caliente" (entre invocaciones).
let _uid = null;
async function uid() {
  if (_uid) return _uid;
  _uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}]);
  if (!_uid) throw new Error("Autenticación con Odoo fallida: revisa base de datos, usuario o API key.");
  return _uid;
}

// Llama cualquier método de cualquier modelo de Odoo.
export async function executeKw(model, method, args = [], kwargs = {}) {
  const id = await uid();
  return jsonrpc("object", "execute_kw", [ODOO_DB, id, ODOO_API_KEY, model, method, args, kwargs]);
}

// Compuerta opcional: si defines PORTAL_TOKEN en Netlify, las funciones exigen
// el header 'x-portal-token'. Útil mientras no haya login formal.
export function checkToken(req) {
  if (!PORTAL_TOKEN) return true; // sin token configurado, no se exige
  const t = req.headers.get("x-portal-token");
  return t === PORTAL_TOKEN;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/* ============================================================
   PARSER COMPARTIDO DE BITÁCORAS
   Los avances de los vendedores se publican con message_post y, según la
   versión de Odoo, el HTML del cuerpo llega ESCAPADO. En la base real quedan
   así:  <p>&lt;b&gt;WhatsApp&lt;/b&gt; · &lt;span&gt;Pendiente de ellos&lt;/span&gt;&lt;br&gt;NOTA</p>
   Este parser entiende los TRES formatos posibles:
     1) etiquetas escapadas  (lo que hay hoy en la base)
     2) etiquetas reales     (<b>Tipo</b> · <span>Resultado</span><br>nota)
     3) texto plano          (Tipo · Resultado\nnota — formato nuevo del portal)
   Devuelve { tipo, res, nota } o null si el mensaje no es una bitácora.
============================================================ */
const TIPOS_BITACORA = ["Llamada","Correo","WhatsApp","Visita","Reunión","Nota"];
const RESULTADOS_BITACORA = ["Contactado","Sin respuesta","Pendiente de ellos","Avanzó","Se enfrió"];

export function parseBitacora(body, notasLibres){
  let s = String(body || "");
  // 1) decodificar entidades HTML (dos pasadas por si vienen doblemente escapadas)
  for (let i = 0; i < 2 && /&(lt|gt|amp|nbsp|quot|#39);/.test(s); i++) {
    s = s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
         .replace(/&nbsp;/g," ").replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  }
  // 2) intentar por etiquetas
  const mTipo = s.match(/<b>([^<]+)<\/b>/);
  const mRes  = s.match(/<span>([^<]+)<\/span>/);
  // 3) texto plano (quita etiquetas conservando saltos)
  let plano = s.replace(/<br\s*\/?>/gi,"\n").replace(/<\/p>/gi,"\n").replace(/<[^>]+>/g," ")
               .replace(/[ \t]+/g," ").replace(/ ?\n ?/g,"\n").trim();
  let tipo = mTipo ? mTipo[1].trim() : "";
  if (!tipo) {
    const m = plano.match(/^(Llamada|Correo|WhatsApp|Visita|Reunión|Nota)\b/);
    if (m) tipo = m[1];
  }
  if (TIPOS_BITACORA.indexOf(tipo) < 0) {
    /* NOTAS LIBRES: si se pide, aceptar también lo que la gente escribe
       DIRECTO en el chatter de Odoo (sin el formato del portal), para que
       toda actividad registrada salga en el reporte. Se excluyen los
       mensajes automáticos de Odoo. */
    if (!notasLibres) return null;
    const AUTOMATICOS = [
      /o_mail_notification/i, /hay un nuevo lead/i, /new lead.*(team|equipo)/i,
      /lead enriquecido/i, /lead enrichment/i, /o_partner_autocomplete/i,
      /oportunidad creada/i, /opportunity created/i,
      /calificaci[oó]n bant/i, /etapa cambiada/i, /stage changed/i,
    ];
    if (AUTOMATICOS.some((rx) => rx.test(s))) return null;
    const nota = plano.replace(/\s*\n\s*/g," · ").replace(/\s+/g," ").trim();
    if (nota.length < 3) return null; // mensajes de seguimiento sin texto
    return { tipo: "Nota", res: "", nota };
  }
  let res = mRes ? mRes[1].trim() : "";
  // limpiar el encabezado (tipo y resultado) del texto plano para quedarnos con la nota
  if (plano.startsWith(tipo)) plano = plano.slice(tipo.length).replace(/^[\s:·—-]+/,"");
  if (!res) { const r = RESULTADOS_BITACORA.find(x => plano.startsWith(x)); if (r) res = r; }
  if (res && plano.startsWith(res)) plano = plano.slice(res.length).replace(/^[\s:·—-]+/,"");
  const nota = plano.replace(/\s*\n\s*/g," · ").replace(/\s+/g," ").trim();
  return { tipo, res, nota };
}

/* ============================================================
   DICCIONARIO DE ETAPAS ROBUSTO A IDIOMAS
   En Odoo el nombre de la etapa es TRADUCIBLE: la que el usuario ve como
   "Por contactar" puede tener el nombre base "New" (etapa por defecto
   renombrada desde la interfaz en español). El API regresa el nombre base,
   así que clasificar por nombre falla. Este helper lee crm.stage en el idioma
   base Y en cada idioma español instalado, y regresa:
     - nombres: { id -> Set(todas las variantes del nombre) }
     - display: { id -> nombre para mostrar (gana la variante en español) }
   La segmentación de los reportes se hace entonces POR ID de etapa: donde
   esté parado físicamente el registro, ahí cuenta.
============================================================ */
const normEt = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export async function diccionarioEtapas() {
  const nombres = {};   // id -> Set de variantes
  const display = {};   // id -> nombre preferido (español si existe)
  const add = (arr, esEspanol) => (arr || []).forEach((st) => {
    const n = String(st.name || "").trim();
    if (!n) return;
    (nombres[st.id] = nombres[st.id] || new Set()).add(n);
    if (esEspanol || !display[st.id]) display[st.id] = n;
  });
  add(await executeKw("crm.stage", "search_read", [[]], { fields: ["id", "name"] }).catch(() => []), false);
  let langs = [];
  try {
    const ls = await executeKw("res.lang", "search_read", [[["active", "=", true]]], { fields: ["code"] });
    langs = ls.map((l) => l.code).filter((c) => /^es/i.test(c));
  } catch (e) {}
  for (const code of langs) {
    add(await executeKw("crm.stage", "search_read", [[]],
      { fields: ["id", "name"], context: { lang: code } }).catch(() => []), true);
  }
  return {
    nombres, display,
    // ids de las etapas cuyo nombre (en CUALQUIER idioma) coincide con la lista dada
    idsDe(listaNombres) {
      const objetivo = listaNombres.map(normEt);
      return Object.entries(nombres)
        .filter(([, set]) => [...set].some((n) => objetivo.includes(normEt(n))))
        .map(([id]) => Number(id));
    },
    // ¿la etapa <id> corresponde a alguno de estos nombres? regresa el nombre canónico o null
    canonicaDe(id, listaNombres) {
      const set = nombres[id];
      if (!set) return null;
      for (const canon of listaNombres) {
        if ([...set].some((n) => normEt(n) === normEt(canon))) return canon;
      }
      return null;
    },
  };
}
