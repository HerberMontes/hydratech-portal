// auth-gate.js — Protege las páginas internas con Netlify Identity.
// Incluir en el <head> de cada página privada:  <script defer src="auth-gate.js"></script>
(function () {
  var ov = document.createElement("div");
  ov.id = "ht-auth-overlay";
  ov.style.cssText =
    "position:fixed;inset:0;z-index:9000;background:#141829;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;";
  ov.innerHTML =
    '<div style="text-align:center;color:#aeb6d4;">' +
    '<div style="font-family:ui-monospace,monospace;letter-spacing:.22em;font-size:12px;color:#5b6390;">ACCESO INTERNO · HYDRATECH</div>' +
    '<div id="ht-auth-msg" style="margin-top:12px;font-size:14px;">Verificando acceso…</div>' +
    '<button id="ht-auth-login" style="display:none;margin-top:16px;background:#263370;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;">Iniciar sesión</button>' +
    "</div>";
  function mount() { (document.body || document.documentElement).appendChild(ov); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  function blocked() {
    var m = document.getElementById("ht-auth-msg"), b = document.getElementById("ht-auth-login");
    if (m) m.textContent = "Esta sección es privada.";
    if (b) { b.style.display = "inline-block"; b.onclick = function () { window.netlifyIdentity && window.netlifyIdentity.open("login"); }; }
  }

  var s = document.createElement("script");
  s.src = "https://identity.netlify.com/v1/netlify-identity-widget.js";
  s.onload = function () {
    var id = window.netlifyIdentity;
    id.on("init", function (user) {
      if (user) { ov.remove(); }
      else { blocked(); id.open("login"); }
    });
    // Cuando se abre el formulario de Netlify, ocultamos la pantalla azul para que SÍ se vea.
    id.on("open", function () { ov.style.display = "none"; });
    // Si cierran el formulario sin entrar, volvemos a bloquear.
    id.on("close", function () { if (!id.currentUser()) { ov.style.display = "flex"; } });
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
