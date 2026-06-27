// auth-gate.js — Login + permisos por rol con Netlify Identity.
// Páginas internas:           <script defer src="auth-gate.js"></script>
// Páginas que exigen un rol:   <script>window.REQUIRE_ROLE='reportes';</script>  (antes del include)
(function () {
  var REQ = window.REQUIRE_ROLE;

  var ov = document.createElement("div");
  ov.id = "ht-auth-overlay";
  ov.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;background:#141829;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;";
  ov.innerHTML =
    '<div style="text-align:center;color:#aeb6d4;max-width:340px;padding:20px;">' +
    '<div style="font-family:ui-monospace,monospace;letter-spacing:.22em;font-size:12px;color:#5b6390;">ACCESO INTERNO · HYDRATECH</div>' +
    '<div id="ht-auth-msg" style="margin-top:12px;font-size:14px;">Verificando acceso…</div>' +
    '<div id="ht-auth-actions" style="margin-top:16px;"></div>' +
    "</div>";
  function mount() { (document.body || document.documentElement).appendChild(ov); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  // El formulario de Netlify SIEMPRE por encima de nuestra pantalla de bloqueo.
  var st = document.createElement("style");
  st.textContent = "#netlify-identity-widget{z-index:2147483647 !important;}";
  document.head.appendChild(st);

  function widgetEl() { return document.getElementById("netlify-identity-widget"); }
  function hideWidget() { var w = widgetEl(); if (w) w.style.display = "none"; }
  function showWidget() { var w = widgetEl(); if (w) w.style.display = ""; }
  function setMsg(t) { var m = document.getElementById("ht-auth-msg"); if (m) m.textContent = t; }
  function actions(html) { var a = document.getElementById("ht-auth-actions"); if (a) a.innerHTML = html; }
  var btnCss = "background:#263370;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;margin:4px;";
  var lnkCss = "display:inline-block;color:#8a93b8;font-size:13px;margin-top:10px;text-decoration:underline;cursor:pointer;";

  function loginUI() {
    setMsg("Esta sección es privada. Inicia sesión para continuar.");
    actions('<button id="ht-login-btn" style="' + btnCss + '">Iniciar sesión</button>');
    var b = document.getElementById("ht-login-btn");
    if (b) b.onclick = function () { window.netlifyIdentity && window.netlifyIdentity.open("login"); };
  }
  function denyUI() {
    setMsg("Tu cuenta no tiene permiso para esta sección.");
    actions('<button onclick="location.href=\'acceso.html\'" style="' + btnCss + '">Volver</button>' +
            '<div onclick="cerrarSesion()" style="' + lnkCss + '">Cerrar sesión</div>');
  }

  function proceed(user) {
    var roles = (user.app_metadata && user.app_metadata.roles) || [];
    window.HT_USER = user; window.HT_ROLES = roles; window.HT_IS_ADMIN = roles.indexOf("admin") >= 0;
    if (REQ && !(window.HT_IS_ADMIN || roles.indexOf(REQ) >= 0)) { denyUI(); return; }
    ov.remove();
    if (typeof window.onAuthReady === "function") { try { window.onAuthReady(user); } catch (e) {} }
  }

  var s = document.createElement("script");
  s.src = "https://identity.netlify.com/v1/netlify-identity-widget.js";
  s.onload = function () {
    var id = window.netlifyIdentity;
    id.on("init", function (user) {
      setTimeout(hideWidget, 0);
      if (!user) { loginUI(); id.open("login"); return; }
      // Validar que la sesión siga siendo válida (rechaza usuarios borrados/expirados).
      if (user.jwt) {
        user.jwt().then(function () { proceed(user); })
                  .catch(function () { try { id.logout(); } catch (e) {} loginUI(); id.open("login"); });
      } else { proceed(user); }
    });
    id.on("open", function () { showWidget(); });            // NO ocultamos la pantalla de bloqueo
    id.on("close", function () { hideWidget(); if (!id.currentUser()) { loginUI(); } });
    id.on("login", function () { id.close(); location.reload(); });
    id.on("logout", function () { location.href = "index.html"; });
    id.init();
  };
  s.onerror = function () { setMsg("No se pudo cargar el acceso. Revisa tu conexión."); };
  document.head.appendChild(s);

  window.cerrarSesion = function () {
    var nuke = function () {
      try { localStorage.clear(); } catch (e) {}
      try { sessionStorage.clear(); } catch (e) {}
      try { document.cookie.split(";").forEach(function (c) { var n = c.split("=")[0].trim(); document.cookie = n + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/"; }); } catch (e) {}
    };
    var go = function () { nuke(); location.href = "index.html"; };
    try {
      var id = window.netlifyIdentity;
      if (id && id.logout) { var p = id.logout(); if (p && p.then) p.then(go, go); setTimeout(go, 700); }
      else go();
    } catch (e) { go(); }
  };
})();
