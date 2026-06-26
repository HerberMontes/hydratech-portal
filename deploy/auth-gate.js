// auth-gate.js — Protege las páginas internas con Netlify Identity.
// Incluir en el <head> de cada página privada:  <script defer src="auth-gate.js"></script>
(function () {
  var ov = document.createElement("div");
  ov.id = "ht-auth-overlay";
  ov.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:#141829;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;";
  ov.innerHTML =
    '<div style="text-align:center;color:#aeb6d4;">' +
    '<div style="font-family:ui-monospace,monospace;letter-spacing:.22em;font-size:12px;color:#5b6390;">ACCESO INTERNO · HYDRATECH</div>' +
    '<div id="ht-auth-msg" style="margin-top:12px;font-size:14px;">Verificando acceso…</div>' +
    '<button id="ht-auth-login" style="display:none;margin-top:16px;background:#263370;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;">Iniciar sesión</button>' +
    "</div>";
  function mount() { (document.body || document.documentElement).appendChild(ov); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  var s = document.createElement("script");
  s.src = "https://identity.netlify.com/v1/netlify-identity-widget.js";
  s.onload = function () {
    var id = window.netlifyIdentity;
    function blocked() {
      var m = document.getElementById("ht-auth-msg"), b = document.getElementById("ht-auth-login");
      if (m) m.textContent = "Esta sección es privada.";
      if (b) { b.style.display = "inline-block"; b.onclick = function () { id.open("login"); }; }
    }
    id.on("init", function (user) {
      if (user) { ov.remove(); } else { id.open("login"); blocked(); }
    });
    id.on("login", function () { id.close(); location.reload(); });
    id.on("logout", function () { location.href = "index.html"; });
    id.init();
  };
  s.onerror = function () {
    var m = document.getElementById("ht-auth-msg");
    if (m) m.textContent = "No se pudo cargar el acceso. Revisa tu conexión.";
  };
  document.head.appendChild(s);

  // Para un botón "Cerrar sesión":  onclick="cerrarSesion()"
  window.cerrarSesion = function () { window.netlifyIdentity && window.netlifyIdentity.logout(); };
})();
