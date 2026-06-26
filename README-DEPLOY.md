# HydraTech — sitio + portal con conexión a Odoo

Sitio estático de HydraTech con funciones serverless de Netlify que se conectan a
Odoo para leer **precios, órdenes de venta y cotizaciones**. Las credenciales de
Odoo viven solo en el servidor (variables de entorno de Netlify), nunca en el
navegador.

## Estructura

```
deploy/                      ← el sitio (lo que ve el público)
  index.html                 ← landing (con el candado discreto en el footer)
  acceso.html                ← hub: Configurador / Portal Irontech
  configurador.html          ← configurador de mangueras
  configurador.app.js
  portal.html                ← portal Irontech (placeholder)
  prueba-odoo.html           ← prueba de conexión a Odoo
  assets/
netlify/functions/           ← código que habla con Odoo (servidor)
  lib/odoo.js                ← conector JSON-RPC + auth + token
  odoo-products.js           ← GET /api/odoo-products
netlify.toml                 ← config de build, functions y rutas /api/*
package.json
.env.example                 ← plantilla de variables (NO subir el .env real)
```

## Paso 1 — Generar la API key en Odoo
1. En Odoo, activa el **modo desarrollador** (Ajustes → activar herramientas de desarrollador).
2. Ve a tu **perfil de usuario → pestaña Seguridad de la cuenta → Claves API (API Keys)**.
3. Genera una nueva clave y cópiala (solo se muestra una vez).
4. Anota también:
   - **ODOO_URL**: la URL de tu Odoo (Odoo Online suele ser `https://tuempresa.odoo.com`).
   - **ODOO_DB**: el nombre de la base de datos (en Odoo Online normalmente es el subdominio: `tuempresa`).
   - **ODOO_USERNAME**: el correo/usuario con el que entras a Odoo.

> La API key tiene los mismos permisos que el usuario. Conviene crear un usuario
> de integración con permisos de solo lectura sobre ventas/productos.

## Paso 2 — Subir el repo a GitHub
1. Crea un repositorio nuevo (privado).
2. Sube el contenido de esta carpeta. El archivo `.gitignore` ya evita subir `.env`.

## Paso 3 — Conectar Netlify a GitHub
1. En Netlify: **Add new site → Import from Git → GitHub** y elige el repo.
2. Netlify lee `netlify.toml` solo (publish = `deploy`, functions = `netlify/functions`).
3. **Site settings → Environment variables**, agrega:
   - `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY`
   - `PORTAL_TOKEN` (opcional; un texto largo aleatorio para proteger las funciones).
4. **Deploy**. Cada `git push` vuelve a desplegar automáticamente.

## Paso 4 — Probar
Abre `https://tu-sitio.netlify.app/prueba-odoo.html`, escribe un código de producto
(o déjalo vacío) y pulsa **Probar**. Si ves la lista con precios, la conexión funciona.

## Dominio
Cuando todo funcione en la URL de Netlify, en GoDaddy apunta `hidratechgroup.mx`
a Netlify (Netlify da los registros DNS). Activa HTTPS (gratis en Netlify).

## Reportes de actividad por orden (ya incluido)
- `odoo-sale-orders.js` — `GET /api/odoo-sale-orders?q=` busca órdenes de venta por número o cliente.
- `odoo-order-activity.js` —
  - `GET /api/odoo-order-activity?id=NN` detalle de la orden, líneas, actividades pendientes y bitácora (chatter).
  - `POST /api/odoo-order-activity` con `{ order_id, text }` registra un reporte que queda en la bitácora de la orden en Odoo.
- Página: `reportes.html` (también enlazada desde `acceso.html`).

> El POST **escribe** en Odoo. Mientras no haya login formal, protégelo con
> `PORTAL_TOKEN`. Para producción conviene agregar autenticación real (p. ej.
> Netlify Identity) antes de exponer la escritura.

## Siguientes pasos sugeridos
- Cablear el configurador para usar precios en vivo de Odoo en vez del catálogo embebido.
- Login real para el portal (en lugar del token compartido).
- Más reportes (por cliente, por periodo) y exportación.
