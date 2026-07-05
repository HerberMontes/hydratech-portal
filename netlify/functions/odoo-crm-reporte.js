// netlify/functions/odoo-crm-reporte.js
// GET /api/odoo-crm-reporte?vendedor=<hr.employee id>&semana=<ISO week>
// Arma el reporte semanal de un vendedor desde Odoo (crm.lead + mail.activity).
// Período: una semana lunes–domingo. Si no se pasa 'semana', usa la última completa.
// Identificación del vendedor: por correo del empleado -> res.users.
import { executeKw, checkToken, json } from "./lib/odoo.js";

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
    // Etiqueta del vendedor (MISMA convención que odoo-crm-lead.js).
    let tagId = 0;
    if (vendedor && vendedor !== "—") {
      const tg = await executeKw("crm.tag", "search_read",
        [[["name", "=", "Vendedor · " + vendedor]]], { fields: ["id"], limit: 1 }).catch(() => []);
      if (tg && tg.length) tagId = tg[0].id;
    }
    // Todas las consultas filtran por esta etiqueta (-1 = sin coincidencias).
    const userDomain = ["tag_ids", "in", [tagId || -1]];

    // Equipo: tomado de un lead del vendedor (mejor esfuerzo)
    try {
      const t = await executeKw("crm.lead", "search_read",
        [[userDomain, ["team_id", "!=", false]]], { fields: ["team_id"], limit: 1 });
      if (t && t.length) equipo = m2oName(t[0].team_id) || "—";
    } catch (e) {}

    /* ----- 2) RESULTADO (crm.lead, confiable) ----- */
    // Creadas en la semana (valor agregado al pipeline + nuevas oportunidades)
    const creadas = await executeKw("crm.lead", "search_read",
      [[userDomain, ["create_date", ">=", W.start], ["create_date", "<=", W.end]]],
      { fields: ["expected_revenue", "type"] });
    const valorPipeline = creadas.reduce((s, r) => s + (r.expected_revenue || 0), 0);
    const nuevasOpps = creadas.filter((r) => r.type === "opportunity").length;

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
        [[userDomain, ["type", "=", "opportunity"], ["active", "=", true], ["activity_ids", "=", false]]]);
    } catch (e) {}
    try {
      vencidas = await executeKw("crm.lead", "search_count",
        [[userDomain, ["active", "=", true], ["activity_state", "=", "overdue"]]]);
    } catch (e) {}

    /* ----- 4) OPORTUNIDADES ABIERTAS (salud del pipeline + etapas + seguimiento) ----- */
    const abiertas = await executeKw("crm.lead", "search_read",
      [[userDomain, ["type", "=", "opportunity"], ["active", "=", true]]],
      { fields: ["partner_name", "contact_name", "partner_id", "stage_id",
                 "expected_revenue", "activity_summary", "activity_date_deadline",
                 "date_last_stage_update", "create_date", "write_date"],
        order: "expected_revenue desc", limit: 500 });

    const opps = abiertas.slice(0, 5);
    const oportunidades = opps.map((o) => ({
      cliente: o.partner_name || m2oName(o.partner_id) || o.contact_name || "—",
      etapa: m2oName(o.stage_id) || "—",
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
      const st = m2oName(o.stage_id) || "—";
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
        etapa: m2oName(o.stage_id) || "—",
        dias: diasDesde(o.write_date) || 0,
      }))
      .filter((o) => o.dias >= 4)
      .sort((a, b) => b.dias - a.dias)
      .slice(0, 4);
    const riesgoTotal = seguimiento.reduce((s, o) => s + o.monto, 0);

    /* ----- 5) ACTIVIDAD (mail.message sobre los leads del vendedor) ----- */
    // Como hay un solo usuario de Odoo, no atribuimos por autor sino por los
    // LEADS del vendedor (sus registros etiquetados). Es un proxy correcto y
    // por-persona de su actividad. Mejor esfuerzo: si no hay historial, queda en 0.
    let completadas = 0, llamadas = 0, reuniones = 0;
    const trend = DIAS.map((d) => ({ day: d, value: 0 }));
    try {
      const repLeads = tagId
        ? await executeKw("crm.lead", "search", [[userDomain]], { limit: 1000 })
        : [];
      if (repLeads.length) {
        const baseMsg = [
          ["model", "=", "crm.lead"],
          ["res_id", "in", repLeads],
          ["mail_activity_type_id", "!=", false],
          ["date", ">=", W.start], ["date", "<=", W.end],
        ];
        completadas = await executeKw("mail.message", "search_count", [baseMsg]);

        // Por día (7 consultas pequeñas)
        for (let i = 0; i < 7; i++) {
          const dStart = new Date(W.monday); dStart.setUTCDate(W.monday.getUTCDate() + i);
          const a = `${dStart.getUTCFullYear()}-${String(dStart.getUTCMonth() + 1).padStart(2, "0")}-${String(dStart.getUTCDate()).padStart(2, "0")}`;
          trend[i].value = await executeKw("mail.message", "search_count",
            [[["model", "=", "crm.lead"], ["res_id", "in", repLeads],
              ["mail_activity_type_id", "!=", false],
              ["date", ">=", a + " 00:00:00"], ["date", "<=", a + " 23:59:59"]]]);
        }

        // Llamadas / reuniones por tipo de actividad (nombres pueden variar)
        const tipos = await executeKw("mail.activity.type", "search_read",
          [[]], { fields: ["id", "name", "category"] }).catch(() => []);
        const idsPorCat = (cat, kw) => tipos
          .filter((t) => (t.category === cat) || (t.name || "").toLowerCase().includes(kw))
          .map((t) => t.id);
        const callIds = idsPorCat("phonecall", "llam");
        const meetIds = idsPorCat("meeting", "reuni");
        if (callIds.length)
          llamadas = await executeKw("mail.message", "search_count",
            [[...baseMsg, ["mail_activity_type_id", "in", callIds]]]);
        if (meetIds.length)
          reuniones = await executeKw("mail.message", "search_count",
            [[...baseMsg, ["mail_activity_type_id", "in", meetIds]]]);
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
      generado: "HydraTech CRM",
    };

    return json({ ok: true, reporte });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
