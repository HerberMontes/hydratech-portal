// netlify/functions/odoo-crm-reporte.js
// GET /api/odoo-crm-reporte?vendedor=<hr.employee id>&semana=<ISO week>
// Arma el reporte semanal de un vendedor desde Odoo (crm.lead + mail.activity).
// Período: una semana lunes–domingo. Si no se pasa 'semana', usa la última completa.
// Identificación del vendedor: por correo del empleado -> res.users.
import { executeKw, checkToken, json, parseBitacora, diccionarioEtapas } from "./lib/odoo.js";

/* ---------- utilidades de fecha (semana ISO lunes–domingo) ---------- */
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const DIAS = ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"];

function mondayOfISOWeek(week, year) {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay(); // 0=dom
  const monday = new Date(simple);
  if (dow <= 4) monday.setUTCDate(simple.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  else monday.setUTCDate(simple.getUTCDate() + (8 - dow));
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}
function isoWeekNum(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yStart) / 86400000 + 1) / 7);
}
function rango(semana, year) {
  let mon;
  if (semana && Number(semana) > 0) mon = mondayOfISOWeek(Number(semana), year);
  else {
    // última semana completa: lunes de esta semana menos 7 días
    const now = new Date();
    const dow = now.getUTCDay() || 7;
    mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow - 1) - 7));
    mon.setUTCHours(0, 0, 0, 0);
  }
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const fmt = (d) => `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return {
    start: fmt(mon) + " 00:00:00",
    end: fmt(sun) + " 23:59:59",
    monday: mon, sunday: sun,
    num: isoWeekNum(mon),
    label: `${mon.getUTCDate()} – ${sun.getUTCDate()} ${MESES[sun.getUTCMonth()]} ${sun.getUTCFullYear()}`,
  };
}

/* ---------- formato de moneda compacto ---------- */
function mxn(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + Math.round(n);
}
function fechaCorta(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return "—";
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
}
const m2oName = (v) => (Array.isArray(v) ? v[1] : "");

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);

  const url = new URL(req.url);

  /* Modo lista: regresa los vendedores REALES (desde las etiquetas
     "Vendedor · Nombre", la fuente de verdad de la atribución) para poblar el
     selector de AMBAS páginas de reporte. Antes oportunidades usaba Empleados
     (hr.employee) y si el vendedor no cruzaba ahí, el reporte salía vacío. */
  if (url.searchParams.get("vendedores") === "1") {
    try {
      const tgs = await executeKw("crm.tag", "search_read",
        [[["name", "like", "Vendedor%"]]], { fields: ["id", "name"] });
      const vendedores = [...new Set(tgs
        .map((t) => String(t.name || "").replace(/^\s*Vendedor\s*[·:\-]?\s*/i, "").trim())
        .filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
      return json({ ok: true, vendedores });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }
  const empId = Number(url.searchParams.get("vendedor")) || 0;
  const semana = url.searchParams.get("semana");
  const year = new Date().getUTCFullYear();
  const W = rango(semana, year);

  try {
    /* ----- 1) Vendedor: empleado -> ETIQUETA (sin usuario de Odoo) ----- */
    let vendedor = "—", rol = "—", equipo = "—", email = "";
    if (empId) {
      const emp = await executeKw("hr.employee", "read",
        [[empId], ["name", "job_title", "work_email"]]);
      if (emp && emp.length) {
        vendedor = emp[0].name || "—";
        rol = emp[0].job_title || "—";
        email = emp[0].work_email || "";
      }
    }
    // Si no vino un id numérico, aceptar el nombre directo (?vendedor=Juan Arjón)
    const vendParam = (url.searchParams.get("vendedor") || "").trim();
    if (vendedor === "—" && vendParam && isNaN(Number(vendParam))) vendedor = vendParam;

    // Etiqueta del vendedor (MISMA convención que odoo-crm-lead.js), con
    // búsqueda ROBUSTA: exacta primero y, si no, sin acentos/mayúsculas y por
    // tokens del nombre (así "Juan Arjon" encuentra "Vendedor · Juan Arjón").
    const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    let tagId = 0, tagNombre = "";
    if (vendedor && vendedor !== "—") {
      const tgs = await executeKw("crm.tag", "search_read",
        [[["name", "like", "Vendedor%"]]], { fields: ["id", "name"] }).catch(() => []);
      const objetivo = norm(vendedor);
      const sinPrefijo = (n) => norm(n).replace(/^vendedor\s*[·:\-]?\s*/, "");
      let hit = tgs.find((t) => sinPrefijo(t.name) === objetivo);
      if (!hit) {
        const toks = objetivo.split(" ").filter(Boolean);
        hit = tgs.find((t) => { const n = norm(t.name); return toks.length && toks.every((tk) => n.includes(tk)); });
      }
      if (!hit) {
        // último intento: que el nombre de la etiqueta esté contenido en el del empleado
        hit = tgs.find((t) => { const n = sinPrefijo(t.name); return n && objetivo.includes(n); });
      }
      if (hit) { tagId = hit.id; tagNombre = hit.name; }
    }
    // Todas las consultas filtran por esta etiqueta (-1 = sin coincidencias).
    const userDomain = ["tag_ids", "in", [tagId || -1]];

    /* ----- SEGMENTACIÓN DEL FLUJO POR ETAPA (regla de negocio) -----
       PROSPECTOS  = etapas del embudo de alta: Por contactar → Cita agendada →
                     Presentado → Alta en proceso. Viven en el reporte de prospectos.
       OPORTUNIDADES = de "Nuevo" en adelante hasta "Ganado". Son las de ESTE reporte.
       Nota: Odoo marca type=opportunity incluso a los prospectos, por eso el corte
       correcto es POR ETAPA, no por type. Aquí se excluyen las etapas de prospecto
       tanto de los números como de las actividades/minuta. */
    const ETAPAS_PROSPECTO = ["Por contactar", "Cita agendada", "Presentado", "Alta en proceso"];
    // Diccionario multi-idioma: clasifica POR ID de etapa (donde esté parado
    // físicamente el registro), sin importar si el nombre base está en inglés
    // porque la etapa por defecto fue renombrada desde la interfaz en español.
    let dic = null, etapasProspectoIds = [];
    try {
      dic = await diccionarioEtapas();
      etapasProspectoIds = dic.idsDe(ETAPAS_PROSPECTO);
    } catch (e) {}
    // Nombre a mostrar de una etapa (gana la variante en español)
    const ETAPA_ES = { "New": "Nuevo", "Qualified": "Calificado", "Proposition": "Propuesta", "Won": "Ganado" };
    const etapaES = (m2o) => {
      const id = Array.isArray(m2o) ? m2o[0] : null;
      if (dic && id != null && dic.display[id]) return dic.display[id];
      const n = String(m2oName(m2o) || "").trim();
      return ETAPA_ES[n] || n;
    };
    const soloOportunidades = etapasProspectoIds.length
      ? [["stage_id", "not in", etapasProspectoIds]]
      : [];

    // Equipo: tomado de un lead del vendedor (mejor esfuerzo)
    try {
      const t = await executeKw("crm.lead", "search_read",
        [[userDomain, ["team_id", "!=", false]]], { fields: ["team_id"], limit: 1 });
      if (t && t.length) equipo = m2oName(t[0].team_id) || "—";
    } catch (e) {}

    /* ----- 2) RESULTADO (crm.lead, confiable) ----- */
    // Creadas en la semana (valor agregado al pipeline + nuevas oportunidades)
    const creadas = await executeKw("crm.lead", "search_read",
      [[userDomain, ...soloOportunidades, ["create_date", ">=", W.start], ["create_date", "<=", W.end]]],
      { fields: ["expected_revenue", "type"] });
    const valorPipeline = creadas.reduce((s, r) => s + (r.expected_revenue || 0), 0);
    const nuevasOpps = creadas.length; // creadas ya en etapas de oportunidad (Nuevo→)

    // Ganadas en la semana (probability=100 y cerradas en el rango)
    const ganadas = await executeKw("crm.lead", "search_read",
      [[userDomain, ["probability", "=", 100], ["date_closed", ">=", W.start], ["date_closed", "<=", W.end]]],
      { fields: ["expected_revenue"] }).catch(() => []);
    const montoCerrado = ganadas.reduce((s, r) => s + (r.expected_revenue || 0), 0);

    // Tasa de cierre de la semana = ganadas / (ganadas + perdidas)
    let perdidas = 0;
    try {
      perdidas = await executeKw("crm.lead", "search_count",
        [[userDomain, ["active", "=", false], ["date_closed", ">=", W.start], ["date_closed", "<=", W.end]]]);
    } catch (e) {}
    const cierre = (ganadas.length + perdidas) ? Math.round((ganadas.length / (ganadas.length + perdidas)) * 100) : 0;

    /* ----- 3) ALERTAS DE COACHING (estado actual) ----- */
    let sinPaso = 0, vencidas = 0;
    try {
      sinPaso = await executeKw("crm.lead", "search_count",
        [[userDomain, ...soloOportunidades, ["active", "=", true], ["probability", "<", 100], ["activity_ids", "=", false]]]);
    } catch (e) {}
    try {
      vencidas = await executeKw("crm.lead", "search_count",
        [[userDomain, ...soloOportunidades, ["active", "=", true], ["activity_state", "=", "overdue"]]]);
    } catch (e) {}

    /* ----- 4) OPORTUNIDADES ABIERTAS (salud del pipeline + etapas + seguimiento) ----- */
    const abiertas = await executeKw("crm.lead", "search_read",
      [[userDomain, ...soloOportunidades, ["active", "=", true], ["probability", "<", 100]]],
      { fields: ["partner_name", "contact_name", "partner_id", "stage_id",
                 "expected_revenue", "activity_summary", "activity_date_deadline",
                 "date_last_stage_update", "create_date", "write_date"],
        order: "expected_revenue desc", limit: 500 });

    const opps = abiertas.slice(0, 5);
    const oportunidades = opps.map((o) => ({
      cliente: o.partner_name || m2oName(o.partner_id) || o.contact_name || "—",
      etapa: etapaES(o.stage_id) || "—",
      monto: mxn(o.expected_revenue),
      paso: o.activity_summary || "",
      fecha: fechaCorta(o.activity_date_deadline),
    }));

    const DAY = 86400000;
    const hoy = Date.now();
    const diasDesde = (s) => {
      if (!s) return null;
      const t = Date.parse(String(s).replace(" ", "T") + "Z");
      return isNaN(t) ? null : Math.max(0, Math.round((hoy - t) / DAY));
    };

    // Salud del pipeline
    const pipelineAbierto = abiertas.reduce((s, r) => s + (r.expected_revenue || 0), 0);
    const metaCobertura = Number(process.env.CRM_META_PIPELINE || 0); // MXN; 0 = sin meta configurada
    const pipeline = {
      abierto: pipelineAbierto,
      abiertoFmt: mxn(pipelineAbierto),
      abiertoExacto: "$" + Math.round(pipelineAbierto).toLocaleString("en-US") + " MXN",
      opps: abiertas.length,
      promedioFmt: abiertas.length ? mxn(pipelineAbierto / abiertas.length) : "$0",
      meta: metaCobertura,
      cobertura: metaCobertura ? Math.round((pipelineAbierto / metaCobertura) * 10) / 10 : null,
    };

    // Desglose por etapa (dónde está parado el pipeline)
    const porEtapa = {};
    abiertas.forEach((o) => {
      const st = etapaES(o.stage_id) || "—";
      (porEtapa[st] = porEtapa[st] || { nombre: st, opps: 0, monto: 0, edades: [] });
      porEtapa[st].opps++;
      porEtapa[st].monto += o.expected_revenue || 0;
      const d = diasDesde(o.date_last_stage_update || o.create_date);
      if (d != null) porEtapa[st].edades.push(d);
    });
    const maxMontoEtapa = Math.max(1, ...Object.values(porEtapa).map((e) => e.monto));
    const etapas = Object.values(porEtapa)
      .sort((a, b) => b.monto - a.monto)
      .slice(0, 3)
      .map((e) => {
        const edad = e.edades.length ? Math.round(e.edades.reduce((a, b) => a + b, 0) / e.edades.length) : 0;
        return {
          nombre: e.nombre, opps: e.opps, montoFmt: mxn(e.monto),
          pct: Math.round((e.monto / maxMontoEtapa) * 100),
          edadProm: edad,
          salud: edad > 10 ? "atorado" : edad > 6 ? "vigilar" : "sano",
        };
      });

    // Requiere seguimiento: abiertas con más días sin tocar (proxy: última modificación)
    const seguimiento = abiertas
      .map((o) => ({
        cliente: o.partner_name || m2oName(o.partner_id) || o.contact_name || "—",
        monto: o.expected_revenue || 0,
        montoFmt: "$" + Math.round(o.expected_revenue || 0).toLocaleString("en-US"),
        etapa: etapaES(o.stage_id) || "—",
        dias: diasDesde(o.write_date) || 0,
      }))
      .filter((o) => o.dias >= 4)
      .sort((a, b) => b.dias - a.dias)
      .slice(0, 4);
    const riesgoTotal = seguimiento.reduce((s, o) => s + o.monto, 0);

    /* ----- 5) ACTIVIDAD (bitácora del CRM sobre los leads del vendedor) ----- */
    // Los vendedores registran su actividad como COMENTARIOS de bitácora con el
    // formato "<b>Tipo</b> · <span>Resultado</span><br>nota" (igual que en
    // crm-actividad y el embudo). Esa es la fuente principal del reporte y de
    // la minuta. Respaldo: actividades formales de Odoo (mail.activity), por si
    // algún equipo las usa.
    let completadas = 0, llamadas = 0, reuniones = 0;
    const minutaC = []; // detalle por día para la hoja 2 del reporte
    const limpiarHtml = (h) => String(h || "")
      .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
    const TIPOS_BIT = ["Llamada", "Correo", "WhatsApp", "Visita", "Reunión", "Nota"];
    const trend = DIAS.map((d) => ({ day: d, value: 0 }));
    let diagLeads = 0, diagComments = 0, diagMuestra = [];
    try {
      // Solo leads en etapas de OPORTUNIDAD: las actividades de prospectos
      // (Por contactar → Alta en proceso) viven en el reporte de prospectos.
      const repLeads = tagId
        ? await executeKw("crm.lead", "search", [[userDomain, ...soloOportunidades]], { limit: 1000 })
        : [];
      diagLeads = repLeads.length;
      if (repLeads.length) {
        // Nombres de los leads (para mostrar el cliente en la minuta)
        const nm = await executeKw("crm.lead", "read",
          [repLeads, ["partner_name", "contact_name", "name"]]).catch(() => []);
        const nameMap = Object.fromEntries(nm.map((l) => [l.id, l.partner_name || l.contact_name || l.name || "—"]));

        const pushMinuta = (fecha, resId, tipo, nota) => {
          if (minutaC.length >= 120) return;
          minutaC.push({
            fecha,
            cliente: nameMap[resId] || "—",
            tipo,
            nota: nota.length > 220 ? nota.slice(0, 217) + "…" : nota,
          });
        };
        const marcarTrend = (fecha) => {
          const t = Date.parse(String(fecha).replace(" ", "T") + "Z");
          if (isNaN(t)) return;
          const idx = Math.floor((t - W.monday.getTime()) / 86400000);
          if (idx >= 0 && idx < 7) trend[idx].value++;
        };

        /* 5a) FUENTE PRINCIPAL: bitácora (mail.message tipo comment) */
        // Sin filtro de message_type: según la versión de Odoo, las notas del
        // chatter pueden guardarse como 'comment' o 'notification'. El parser
        // de abajo ya filtra por el formato de la bitácora (<b>Tipo</b>).
        const msgs = await executeKw("mail.message", "search_read",
          [[["model", "=", "crm.lead"], ["res_id", "in", repLeads],
            ["date", ">=", W.start], ["date", "<=", W.end]]],
          { fields: ["body", "date", "res_id"], order: "date asc", limit: 3000 }).catch(() => []);
        diagComments = msgs.length;
        diagMuestra = msgs.slice(0, 3).map((m) => ({ date: m.date, body: String(m.body || "").slice(0, 140) }));
        msgs.forEach((m) => {
          // Parser compartido: entiende etiquetas reales, ESCAPADAS (formato
          // actual en la base) y texto plano. Ver lib/odoo.js.
          const pb = parseBitacora(m.body, true); // true = incluir notas libres escritas directo en Odoo
          if (!pb) return;
          completadas++;
          if (pb.tipo === "Llamada") llamadas++;
          if (pb.tipo === "Reunión") reuniones++;
          marcarTrend(m.date);
          const nota = pb.res ? (pb.nota ? pb.res + " — " + pb.nota : pb.res) : pb.nota;
          pushMinuta(m.date, m.res_id, pb.tipo, nota);
        });

        /* 5b) RESPALDO: actividades formales de Odoo, solo si no hubo bitácora */
        if (!completadas) {
          const baseMsg = [
            ["model", "=", "crm.lead"], ["res_id", "in", repLeads],
            ["mail_activity_type_id", "!=", false],
            ["date", ">=", W.start], ["date", "<=", W.end],
          ];
          const msgsAct = await executeKw("mail.message", "search_read",
            [baseMsg],
            { fields: ["date", "res_id", "mail_activity_type_id", "body", "subject"],
              order: "date asc", limit: 200 }).catch(() => []);
          msgsAct.forEach((m) => {
            completadas++;
            const tNom = (m2oName(m.mail_activity_type_id) || "Actividad");
            const tLow = tNom.toLowerCase();
            if (tLow.includes("llam") || tLow.includes("call")) llamadas++;
            if (tLow.includes("reun") || tLow.includes("meet")) reuniones++;
            marcarTrend(m.date);
            pushMinuta(m.date, m.res_id, tNom, limpiarHtml(m.body) || limpiarHtml(m.subject));
          });
        }
      }
    } catch (e) { /* sin historial de actividades -> queda en 0 */ }

    /* ----- 6) Ensamblar en la forma que espera el front ----- */
    const reporte = {
      vendedor, equipo, rol,
      semana: String(W.num), rango: W.label,
      estado: (sinPaso > 0 || vencidas > 0) ? "requiere" : "aldia",
      actividad: [
        { label: "Actividades completadas", value: String(completadas), sub: "en la semana" },
        { label: "Llamadas", value: String(llamadas), sub: "registradas" },
        { label: "Reuniones", value: String(reuniones), sub: "registradas" },
        { label: "Oportunidades nuevas", value: String(nuevasOpps), sub: "al pipeline" },
      ],
      resultado: [
        { label: "Valor agregado al pipeline", value: mxn(valorPipeline), sub: `MXN · ${creadas.length} registros` },
        { label: "Oportunidades ganadas", value: String(ganadas.length), sub: "en la semana" },
        { label: "Monto cerrado", value: mxn(montoCerrado), sub: "MXN" },
        { label: "Tasa de cierre", value: cierre + "%", sub: "ganadas vs. cerradas" },
      ],
      sinPaso, vencidas,
      oportunidades,
      trend,
      // --- campos nuevos para la plantilla "Reporte semanal comercial" ---
      pipeline,
      etapas,
      seguimiento,
      riesgoTotalFmt: "$" + Math.round(riesgoTotal).toLocaleString("en-US"),
      act: { llamadas, reuniones, avances: completadas, nuevas: nuevasOpps },
      res: { ganadas: ganadas.length, cierre, montoCerradoFmt: "$" + Math.round(montoCerrado).toLocaleString("en-US") },
      minuta: minutaC,
      generado: "HydraTech CRM",
    };

    if (url.searchParams.get("debug") === "1") {
      return json({ ok: true, reporte, diag: {
        parametros: { vendedor: url.searchParams.get("vendedor"), semana },
        empleado: vendedor,
        etiqueta: tagNombre || "(NO ENCONTRADA — revisa que exista la etiqueta 'Vendedor · Nombre' en los leads)",
        tagId,
        rango: { inicio: W.start, fin: W.end, semanaISO: W.num },
        segmentacion: "solo etapas de oportunidad (Nuevo→Ganado); excluye " + ETAPAS_PROSPECTO.join(", "),
        etapasProspectoExcluidas: etapasProspectoIds,
        leadsDelVendedor: diagLeads,
        comentariosEnRango: diagComments,
        bitacorasValidas: completadas,
        minutaEntradas: minutaC.length,
        muestraComentarios: diagMuestra,
      }});
    }
    return json({ ok: true, reporte });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
