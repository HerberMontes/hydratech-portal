// netlify/functions/admin-users.js
// Panel de administración de usuarios (solo admins).
// Usa la API de administración de Netlify Identity (token admin de la función).
// GET  -> lista usuarios
// POST {action:"invite", email, roles?}   -> invita por correo
// POST {action:"roles",  id, roles}        -> guarda permisos
// POST {action:"delete", id}               -> elimina usuario
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TOOL_ROLES = ["reportes", "cotizador", "ventas", "admin"];
const J = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

export const handler = async (event, context) => {
  const cc = context.clientContext || {};
  const identity = cc.identity, user = cc.user;
  if (!user) return J(401, { ok: false, error: "Inicia sesión." });
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const email = (user.email || "").toLowerCase();
  const isAdmin = roles.includes("admin") || ADMIN_EMAILS.includes(email);
  if (!isAdmin) return J(403, { ok: false, error: "Solo administradores." });
  if (!identity || !identity.url || !identity.token) return J(500, { ok: false, error: "Identity no disponible en la función. ¿Está habilitado?" });

  const base = identity.url;
  const H = { Authorization: "Bearer " + identity.token, "Content-Type": "application/json" };
  const clean = (arr) => (Array.isArray(arr) ? arr.filter((x) => TOOL_ROLES.includes(x)) : []);

  try {
    if (event.httpMethod === "GET") {
      const r = await fetch(base + "/admin/users", { headers: H });
      const d = await r.json();
      if (!r.ok) throw new Error(d.msg || d.error_description || "HTTP " + r.status);
      const users = (d.users || []).map((u) => ({
        id: u.id, email: u.email,
        roles: (u.app_metadata && u.app_metadata.roles) || [],
        confirmed: !!(u.confirmed_at || u.email_confirmed_at),
      }));
      return J(200, { ok: true, users, me: email });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      if (body.action === "invite") {
        if (!body.email) return J(400, { ok: false, error: "Falta el correo." });
        const r = await fetch(base + "/invite", { method: "POST", headers: H, body: JSON.stringify({ email: body.email }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.msg || d.error_description || "HTTP " + r.status);
        if (d.id && body.roles) {
          await fetch(base + "/admin/users/" + d.id, { method: "PUT", headers: H, body: JSON.stringify({ app_metadata: { roles: clean(body.roles) } }) }).catch(() => {});
        }
        return J(200, { ok: true });
      }
      if (body.action === "roles") {
        if (!body.id) return J(400, { ok: false, error: "Falta el usuario." });
        const r = await fetch(base + "/admin/users/" + body.id, { method: "PUT", headers: H, body: JSON.stringify({ app_metadata: { roles: clean(body.roles) } }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.msg || d.error_description || "HTTP " + r.status);
        return J(200, { ok: true });
      }
      if (body.action === "delete") {
        if (!body.id) return J(400, { ok: false, error: "Falta el usuario." });
        const r = await fetch(base + "/admin/users/" + body.id, { method: "DELETE", headers: H });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.msg || "HTTP " + r.status); }
        return J(200, { ok: true });
      }
      return J(400, { ok: false, error: "Acción no válida." });
    }
    return J(405, { ok: false, error: "Método no permitido." });
  } catch (e) {
    return J(500, { ok: false, error: String(e.message || e) });
  }
};
