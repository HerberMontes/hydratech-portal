// netlify/functions/odoo-crm-embudo.js
// GET /api/odoo-crm-embudo?vendedor=<Nombre>&semana=<N>&curso=<0|1>
//   vendedor : nombre del vendedor (de la etiqueta "Vendedor · Nombre"); vacío = elige el primero
//   semana   : 0 = semana en curso; 1,2,... = semanas cerradas hacia atrás
//   curso    : 1 = recalcular con los días corridos (botón "Actualizar"); si no, foto normal
// Devuelve: lista de vendedores, el embudo de LEADS por etapa (foto actual) y el
// MOVIMIENTO de la semana (cuántos entraron a cada etapa en el periodo) + actividad.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const VEND_PREFIX = "Vendedor · ";
// Etapas del embudo de altas, en orden (nombres EXACTOS del Kanban de Odoo).
const ETAPAS = ["Por contactar", "Cita agendada", "Presentado", "Alta en proceso"];
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const DAY = 24 * 60 * 60 * 1000;

const m2oName = (v) => Array.isArray(v) ? v[1] : "";
const initials = (n) => { const p = String(n||"").trim().split(/\s+/).filter(Boolean); return !p.length ? "··" : p.length===1 ? p[0].slice(0,2).toUpperCase() : (p[0][0]+p[1][0]).toUpperCase(); };
const fmtDia = (d) => `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
const odooDate = (d) => d.toISOString().slice(0, 10);
function parseDate(s){ if(!s) return null; const t=Date.parse(String(s).replace(" ","T")+(String(s).length<=10?"T00:00:00Z":"Z")); return isNaN(t)?null:t; }
function daysSince(s, now){ const t=parseDate(s); return t==null?null:Math.max(0,Math.round((now-t)/DAY)); }
function weekNumber(d){ const t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())); const dn=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-dn); const ys=new Date(Date.UTC(t.getUTCFullYear(),0,1)); return Math.ceil((((t-ys)/DAY)+1)/7); }

// Ventana de la semana. semana=0 => semana EN CURSO (lunes..hoy si curso=1, si no lunes..domingo).
function ventana(offset, curso){
  const now = new Date();
  const dow = now.getUTCDay() || 7; // 1=lun..7=dom
  const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  mon.setUTCDate(mon.getUTCDate() - (dow - 1) - offset * 7);
  const domingo = new Date(mon); domingo.setUTCDate(domingo.getUTCDate() + 6);
  // corte: si es la semana en curso y piden "curso", el fin es HOY; si no, el domingo.
  const enCurso = offset === 0;
  const fin = (enCurso && curso) ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
            : domingo;
  return { mon, domingo, fin, enCurso, now: now.getTime() };
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok: false, error: "No autorizado." }, 401);
  try {
    const url = new URL(req.url);
    const offset = Math.max(0, parseInt(url.searchParams.get("semana") || "0", 10) || 0);
    const curso = url.searchParams.get("curso") === "1";
    const vendedorPick = (url.searchParams.get("vendedor") || "").trim();
    const w = ventana(offset, curso);
    const startStr = odooDate(w.mon) + " 00:00:00";
    const endStr = odooDate(w.fin) + " 23:59:59";
    const periodo = `Semana ${weekNumber(w.mon)} · ${fmtDia(w.mon)}–${fmtDia(w.domingo)} ${w.domingo.getUTCFullYear()}`;
    const corteLabel = (w.enCurso && curso)
      ? `En curso · al ${fmtDia(new Date(w.now))}`
      : (w.enCurso ? "Semana en curso" : "Semana cerrada");

    // 1) Vendedores (etiquetas "Vendedor · X")
    const tags = await executeKw("crm.tag", "search_read",
      [[["name", "like", VEND_PREFIX + "%"]]], { fields: ["id", "name"] });
    const sellers = tags.map(t => ({ tagId: t.id, name: t.name.slice(VEND_PREFIX.length).trim() }));
    if (!sellers.length) return json({ ok: true, periodo, corteLabel, vendedores: [], vendedor: null, embudo: [], movimiento: {}, actividad: {} });

    // vendedor elegido (o el primero)
    const elegido = sellers.find(s => s.name === vendedorPick) || sellers[0];
    const tagId = elegido.tagId;

    // 2) Leads de ese vendedor (tipo lead u opportunity que aún estén en etapas de alta)
    const leads = await executeKw("crm.lead", "search_read",
      [[["tag_ids", "in", [tagId]], ["active", "=", true]]],
      { fields: ["id", "name", "stage_id", "type", "create_date", "date_last_stage_update", "partner_name", "contact_name"], limit: 1000 });

    // 3) Embudo FOTO ACTUAL: cuántos hay hoy en cada etapa de alta
    const enEtapa = Object.fromEntries(ETAPAS.map(e => [e, []]));
    leads.forEach(l => {
      const st = m2oName(l.stage_id);
      if (enEtapa[st]) enEtapa[st].push(l);
    });
    const totalEmbudo = ETAPAS.reduce((a, e) => a + enEtapa[e].length, 0);
    const embudo = ETAPAS.map((e, i) => {
      const arr = enEtapa[e];
      // atorados: llevan >7 días sin moverse de etapa
      const atorados = arr.filter(l => (daysSince(l.date_last_stage_update, w.now) || 0) > 7).length;
      const prevCount = i === 0 ? (arr.length) : enEtapa[ETAPAS[i - 1]].length;
      return {
        etapa: e,
        n: arr.length,
        pct: totalEmbudo ? Math.round(arr.length / totalEmbudo * 100) : 0,
        atorados,
        // conversión respecto a la etapa anterior (cuántos "pasaron")
        convDesdeAnterior: i === 0 ? null : (prevCount ? Math.round(arr.length / prevCount * 100) : null),
      };
    });

    // 4) MOVIMIENTO de la semana: leads que ENTRARON a cada etapa en el periodo
    //    (aprox: su último cambio de etapa cae dentro de la semana y están en esa etapa)
    const movimiento = Object.fromEntries(ETAPAS.map(e => [e, 0]));
    let nuevosLeads = 0, nuevosPrev = 0;
    // semana previa (para el delta del KPI de prospectos nuevos) — mejor esfuerzo sobre leads activos
    const prevMon = new Date(w.mon); prevMon.setUTCDate(prevMon.getUTCDate() - 7);
    const prevDom = new Date(w.mon); prevDom.setUTCDate(prevDom.getUTCDate() - 1);
    const prevStart = odooDate(prevMon) + " 00:00:00";
    const prevEnd = odooDate(prevDom) + " 23:59:59";
    leads.forEach(l => {
      const st = m2oName(l.stage_id);
      const mov = l.date_last_stage_update;
      if (st && movimiento[st] !== undefined && mov && mov >= startStr && mov <= endStr) movimiento[st]++;
      if (l.create_date && l.create_date >= startStr && l.create_date <= endStr) nuevosLeads++;
      if (l.create_date && l.create_date >= prevStart && l.create_date <= prevEnd) nuevosPrev++;
    });

    // 4b) ESTANCADOS: leads con >7 días sin cambio de etapa (para la lista del reporte)
    //     Los de "Alta en proceso" se marcan como críticos (esperando autorización).
    const DETALLE = {
      "Por contactar": "sin primer intento",
      "Cita agendada": "sin confirmar reunión",
      "Presentado": "sin siguiente paso",
      "Alta en proceso": "esperando autorización del cliente",
    };
    const estancados = leads
      .map(l => {
        const st = m2oName(l.stage_id);
        if (!ETAPAS.includes(st)) return null;
        const dias = daysSince(l.date_last_stage_update || l.create_date, w.now);
        if (dias == null || dias <= 7) return null;
        return {
          empresa: l.partner_name || l.contact_name || l.name || "—",
          etapa: st,
          detalle: DETALLE[st] || "sin acción",
          dias,
          critico: st === "Alta en proceso",
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.critico - a.critico) || (b.dias - a.dias))
      .slice(0, 6);

    // 5) Actividad del vendedor en la semana (mail.message de bitácora sobre sus leads)
    const leadIds = leads.map(l => l.id);
    const nombreLead = Object.fromEntries(leads.map(l => [l.id, l.partner_name || l.contact_name || l.name || "—"]));
    const limpiarHtml = (h) => String(h || "")
      .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
    let avances = 0, citas = 0, visitas = 0, llamadas = 0;
    const minuta = []; // detalle por día para la hoja 2 del reporte
    if (leadIds.length) {
      // Sin filtro de message_type (las notas pueden ser 'comment' o
      // 'notification' según la versión de Odoo); el parser filtra por formato.
      const msgs = await executeKw("mail.message", "search_read",
        [[["model", "=", "crm.lead"], ["res_id", "in", leadIds],
          ["date", ">=", startStr], ["date", "<=", endStr]]],
        { fields: ["body", "date", "res_id"], order: "date asc", limit: 3000 }).catch(() => []);
      msgs.forEach(m => {
        const b = m.body || "";
        const mb = b.match(/<b>([^<]+)<\/b>/);
        const tipo = mb ? mb[1].trim() : "";
        if (["Llamada","Correo","WhatsApp","Visita","Reunión","Nota"].indexOf(tipo) < 0) return;
        avances++;
        if (tipo === "Visita") visitas++;
        if (tipo === "Llamada") llamadas++;
        if (tipo === "Reunión") citas++;
        if (minuta.length < 120) {
          const ms = b.match(/<span>([^<]+)<\/span>/);
          const res = ms ? ms[1].trim() : "";
          let nota = limpiarHtml(b);
          if (nota.startsWith(tipo)) nota = nota.slice(tipo.length).replace(/^[\s:·—-]+/, "");
          if (res && nota.startsWith(res)) nota = nota.slice(res.length).replace(/^[\s:·—-]+/, "");
          if (res) nota = nota ? (res + " — " + nota) : res;
          minuta.push({
            fecha: m.date,
            cliente: nombreLead[m.res_id] || "—",
            tipo,
            nota: nota.length > 220 ? nota.slice(0, 217) + "…" : nota,
          });
        }
      });
    }

    return json({
      ok: true,
      periodo, corteLabel,
      enCurso: w.enCurso,
      vendedores: sellers.map(s => s.name),
      vendedor: { nombre: elegido.name, ini: initials(elegido.name) },
      totalEmbudo,
      embudo,
      movimiento, nuevosLeads, nuevosPrev,
      estancados,
      minuta,
      actividad: { avances, citas, visitas, llamadas, altas: movimiento["Alta en proceso"] || 0 },
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};
