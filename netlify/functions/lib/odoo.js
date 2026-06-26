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
