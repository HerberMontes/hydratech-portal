// auth-gate.js — Login + permisos por rol con Netlify Identity.
// En páginas internas:            <script defer src="auth-gate.js"></script>
// En páginas que exigen un rol:   <script>window.REQUIRE_ROLE='reportes';</script>  (antes del include)
// Roles usados: admin (ve todo), reportes, cotizador, ventas.
(function () {
  var ov = document.createElement("div");
  ov.id = "ht-auth-overlay";
  ov.style.cssText =
    "position:fixed;inset:0;z-index:9000;background:#141829;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;";
  ov.innerHTML =
    '<div style="text-align:center;color:#aeb6d4;max-width:340px;padding:20px;">' +
    '<div style="font-family:ui-monospace,monospace;letter-spacing:.22em;font-size:12px;color:#5b6390;">ACCESO INTERNO · HYDRATECH</div>' +
    '<div id="ht-auth-msg" style="margin-top:12px;font-size:14px;">Verificando acceso…</div>' +
    '<div id="ht-auth-actions" style="margin-top:16px;"></div>' +
    "</div>";
  function mount() { (document.body || document.documentElement).appendChild(ov); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  function widgetEl() { return document.getElementById("netlify-identity-widget"); }
  function hideWidget() { var w = widgetEl(); if (w) w.style.display = "none"; }
  function showWidget() { var w = widgetEl(); if (w) w.style.display = ""; }
  function setMsg(t) { var m = document.getElementById("ht-auth-msg"); if (m) m.textContent = t; }
  function actions(html) { var a = document.getElementById("ht-auth-actions"); if (a) a.innerHTML = html; }
  var btnCss = "background:#263370;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;margin:4px;";
  var lnkCss = "display:inline-block;color:#8a93b8;font-size:13px;margin-top:10px;text-decoration:underline;cursor:pointer;";

  function loginUI() {
    setMsg("Esta sección es privada.");
    actions('<button id="ht-login-btn" style="' + btnCss + '">Iniciar sesión</button>');
    var b = document.getElementById("ht-login-btn");
    if (b) b.onclick = function () { window.netlifyIdentity && window.netlifyIdentity.open("login"); };
  }
  function denyUI() {
    setMsg("Tu cuenta no tiene permiso para esta sección.");
    actions('<button onclick="location.href=\'acceso.html\'" style="' + btnCss + '">Volver</button>' +
            '<div onclick="cerrarSesion()" style="' + lnkCss + '">Cerrar sesión</div>');
  }

  var s = document.createElement("script");
  s.src = "https://identity.netlify.com/v1/netlify-identity-widget.js";
  s.onload = function () {
    var id = window.netlifyIdentity;
    id.on("init", function (user) {
      setTimeout(hideWidget, 0);
      if (!user) { loginUI(); id.open("login"); return; }
      var roles = (user.app_metadata && user.app_metadata.roles) || [];
      window.HT_USER = user; window.HT_ROLES = roles; window.HT_IS_ADMIN = roles.indexOf("admin") >= 0;
      var need = window.REQUIRE_ROLE;
      if (need && !(window.HT_IS_ADMIN || roles.indexOf(need) >= 0)) { denyUI(); return; }
      ov.remove();
      if (typeof window.onAuthReady === "function") { try { window.onAuthReady(user); } catch (e) {} }
    });
    id.on("open", function () { ov.style.display = "none"; showWidget(); });
    id.on("close", function () { hideWidget(); if (!id.currentUser()) { ov.style.display = "flex"; } });
    id.on("login", function () { id.close(); location.reload(); });
    id.on("logout", function () { location.href = "index.html"; });
    id.init();
  };
  s.onerror = function () { setMsg("No se pudo cargar el acceso. Revisa tu conexión."); };
  document.head.appendChild(s);

  window.cerrarSesion = function () { window.netlifyIdentity && window.netlifyIdentity.logout(); };
})();
