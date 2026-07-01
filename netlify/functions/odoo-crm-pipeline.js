// netlify/functions/odoo-crm-pipeline.js
// Builds the Commercial Pipeline Report from Odoo for crm-pipeline.html.
// Conventions shared with the rest of the CRM layer:
//   - Salespeople are crm.tag named  "Vendedor · <Name>"  (free, no Odoo seat).
//   - Pipeline stages by EXACT name: Nuevo → Por cotizar → Cotización enviada → Ganado.
//   - Aging is measured with date_last_stage_update.
// The page falls back to sample data if this function errors, so partial
// failures degrade gracefully.

const { executeKw, json, checkToken } = require('./lib/odoo');

const VEND_PREFIX = 'Vendedor · ';
const S_NUEVO = 'Nuevo';
const S_COTIZAR = 'Por cotizar';
const S_ENVIADA = 'Cotización enviada';
const S_GANADO = 'Ganado';

const DAY = 24 * 60 * 60 * 1000;

function fmtBig(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function fmtK(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + Math.round(n);
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function daysSince(dtStr, now) {
  if (!dtStr) return 0;
  const t = Date.parse(dtStr.replace(' ', 'T') + 'Z');
  if (isNaN(t)) return 0;
  return Math.max(0, Math.round((now - t) / DAY));
}
function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
// relational field -> readable name (Odoo returns [id, "name"] or false)
function relName(v) { return Array.isArray(v) ? v[1] : (v || ''); }
function relId(v) { return Array.isArray(v) ? v[0] : (v || false); }

// Reporting window: last complete Monday–Sunday week, offset by ?semana=N (N weeks back).
function reportWindow(offsetWeeks) {
  const now = new Date();
  // Find last Sunday 23:59 (end of last complete week)
  const dow = now.getUTCDay(); // 0=Sun
  const daysToLastSunday = dow === 0 ? 7 : dow; // if today Sun, last complete week ended a week ago
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - daysToLastSunday - offsetWeeks * 7);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { start, end, now: now.getTime() };
}
function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function odooDate(d) {
  return d.toISOString().slice(0, 10);
}

exports.handler = async (req) => {
  const authErr = checkToken(req);
  if (authErr) return authErr;

  try {
    const qs = (req.queryStringParameters || {});
    const offset = Math.max(0, parseInt(qs.semana || '0', 10) || 0);
    const win = reportWindow(offset);
    const now = win.now;
    const periodo = 'Week ' + weekNumber(win.start) + ' · ' +
      fmtDate(win.start) + '–' + fmtDate(win.end) + ', ' + win.end.getUTCFullYear();
    const corteLabel = 'As of ' + fmtDate(new Date(now)) + ', ' + new Date(now).getUTCFullYear();
    const startStr = odooDate(win.start) + ' 00:00:00';
    const endStr = odooDate(win.end) + ' 23:59:59';

    // ---- 1. Stages (resolve names -> ids) ----
    const stages = await executeKw('crm.stage', 'search_read',
      [[]], { fields: ['id', 'name'] });
    const stageByName = {};
    stages.forEach(s => { stageByName[s.name] = s.id; });

    // ---- 2. Salespeople from tags "Vendedor · X" ----
    const tags = await executeKw('crm.tag', 'search_read',
      [[['name', 'like', VEND_PREFIX + '%']]], { fields: ['id', 'name'] });
    const sellers = tags.map(t => ({
      tagId: t.id,
      name: t.name.slice(VEND_PREFIX.length).trim(),
    }));
    const sellerByTag = {};
    sellers.forEach(s => { sellerByTag[s.tagId] = s.name; });

    function repFromTags(tagIds) {
      if (!Array.isArray(tagIds)) return '';
      for (const id of tagIds) if (sellerByTag[id]) return sellerByTag[id];
      return '';
    }

    // ---- 3. Open opportunities (active, type=opportunity) ----
    const openFields = ['id', 'name', 'partner_id', 'expected_revenue', 'stage_id',
      'date_last_stage_update', 'tag_ids', 'priority', 'activity_date_deadline'];
    const open = await executeKw('crm.lead', 'search_read',
      [[['type', '=', 'opportunity'], ['active', '=', true]]],
      { fields: openFields, limit: 2000 });

    // annotate
    open.forEach(o => {
      o._stage = relName(o.stage_id);
      o._age = daysSince(o.date_last_stage_update, now);
      o._rep = repFromTags(o.tag_ids);
      o._client = relName(o.partner_id) || o.name || '—';
      o._val = Number(o.expected_revenue) || 0;
    });

    const activeStages = [S_NUEVO, S_COTIZAR, S_ENVIADA];
    const openActive = open.filter(o => activeStages.indexOf(o._stage) !== -1);

    // ---- 4. Won & lost in the period ----
    // Won: currently in "Ganado" (or 100% probability) that reached it during the window.
    const wonAll = await executeKw('crm.lead', 'search_read',
      [[['type', '=', 'opportunity'],
        ['stage_id', '=', stageByName[S_GANADO] || 0]]],
      { fields: ['id', 'expected_revenue', 'date_last_stage_update', 'create_date', 'tag_ids', 'date_closed'], limit: 2000 });
    const wonPeriod = wonAll.filter(w => {
      const ref = w.date_closed || w.date_last_stage_update;
      return ref && ref >= startStr && ref <= endStr;
    });
    const wonCount = wonPeriod.length;
    const wonValue = wonPeriod.reduce((a, w) => a + (Number(w.expected_revenue) || 0), 0);
    const wonCycle = avg(wonPeriod.map(w =>
      w.create_date ? Math.max(0, Math.round((Date.parse((w.date_closed || w.date_last_stage_update).replace(' ', 'T') + 'Z') - Date.parse(w.create_date.replace(' ', 'T') + 'Z')) / DAY)) : 0
    ).filter(Boolean));

    // Lost: inactive + lost in the window
    let lostRows = [];
    try {
      lostRows = await executeKw('crm.lead', 'search_read',
        [[['type', '=', 'opportunity'], ['active', '=', false],
          ['probability', '=', 0], ['date_closed', '>=', startStr], ['date_closed', '<=', endStr]]],
        { fields: ['id', 'lost_reason_id', 'tag_ids', 'expected_revenue'], limit: 2000, context: { active_test: false } });
    } catch (e) { lostRows = []; }
    const lostCount = lostRows.length;

    // ---- 5. KPIs ----
    const totalPipeline = openActive.reduce((a, o) => a + o._val, 0);
    const closed = wonCount + lostCount;
    const convRate = closed ? Math.round(wonCount / closed * 100) : 0;
    const kpis = [
      { label: 'Open opportunities', value: String(openActive.length), unit: '', sub: 'Across 3 active stages', color: '#1b2138' },
      { label: 'Total pipeline value', value: fmtBig(totalPipeline), unit: 'MXN', sub: 'Sum of ' + openActive.length + ' opportunities', color: '#263370' },
      { label: 'Won this period', value: String(wonCount), unit: '', sub: 'Reached "Ganado"', color: '#16a34a' },
      { label: 'Won value', value: fmtBig(wonValue), unit: 'MXN', sub: wonCount + ' closes this period', color: '#16a34a' },
      { label: 'Conversion rate', value: convRate + '%', unit: '', sub: 'Won / closed', color: '#1b2138' },
    ];

    // ---- 6. Funnel by stage ----
    function stageAgg(stageName) {
      const rows = openActive.filter(o => o._stage === stageName);
      return { conteo: rows.length, valor: rows.reduce((a, o) => a + o._val, 0), dias: avg(rows.map(o => o._age)) };
    }
    const aN = stageAgg(S_NUEVO), aC = stageAgg(S_COTIZAR), aE = stageAgg(S_ENVIADA);
    const etapas = [
      { n: '01', nombre: 'New',        conteo: aN.conteo, valor: aN.valor, dias: aN.dias, diasLabel: 'Avg. age',   neutral: false, estado: 'Active', puedeCuello: false },
      { n: '02', nombre: 'To quote',   conteo: aC.conteo, valor: aC.valor, dias: aC.dias, diasLabel: 'Avg. age',   neutral: false, estado: 'Active', puedeCuello: true },
      { n: '03', nombre: 'Quote sent', conteo: aE.conteo, valor: aE.valor, dias: aE.dias, diasLabel: 'Avg. age',   neutral: false, estado: 'Active', puedeCuello: false },
      { n: '04', nombre: 'Won',        conteo: wonCount,  valor: wonValue, dias: wonCycle, diasLabel: 'Avg. cycle', neutral: true,  estado: 'Result', puedeCuello: false },
    ];

    // ---- 7. Risk zone (bottleneck) ----
    // Not quoted (operational)  = opps stuck in "Por cotizar"
    // Quoted, not advancing     = opps stuck in "Cotización enviada"
    const toRow = o => ({ cliente: o._client, vendedor: o._rep || '—', valor: o._val, dias: o._age });
    const sinCotizar = openActive.filter(o => o._stage === S_COTIZAR)
      .sort((a, b) => b._age - a._age).slice(0, 5).map(toRow);
    const cotizada = openActive.filter(o => o._stage === S_ENVIADA)
      .sort((a, b) => b._age - a._age).slice(0, 5).map(toRow);

    // ---- 8. BANT health (proxy via priority set during "Calificar") ----
    // priority '3' → well qualified, '2' → partial, '0'/'1'/none → weak / no BANT
    let verde = 0, ambar = 0, rojo = 0;
    openActive.forEach(o => {
      const p = String(o.priority || '0');
      if (p === '3') verde++;
      else if (p === '2') ambar++;
      else rojo++;
    });
    const bant = {
      verde: { n: verde, label: 'Well qualified',      desc: 'Complete BANT' },
      ambar: { n: ambar, label: 'Partially qualified', desc: 'Missing 1–2 criteria' },
      rojo:  { n: rojo,  label: 'Weak / no BANT',      desc: 'Needs discovery' },
    };

    // ---- 9. Rep performance ----
    const today = odooDate(new Date(now));
    const vendedores = sellers.map(s => {
      const mine = openActive.filter(o => o._rep === s.name);
      const visitas = mine.filter(o => o._stage !== S_NUEVO).length; // visit/levantamiento done
      const cotizaciones = mine.filter(o => o._stage === S_ENVIADA).length +
        wonPeriod.filter(w => repFromTags(w.tag_ids) === s.name).length;
      const withNext = mine.filter(o => o.activity_date_deadline).length;
      const withoutNext = mine.length - withNext;
      const overdue = mine.filter(o => o.activity_date_deadline && o.activity_date_deadline < today).length;
      const ganadas = wonPeriod.filter(w => repFromTags(w.tag_ids) === s.name).length;
      const valorGanado = wonPeriod.filter(w => repFromTags(w.tag_ids) === s.name)
        .reduce((a, w) => a + (Number(w.expected_revenue) || 0), 0);
      const lostMine = lostRows.filter(l => repFromTags(l.tag_ids) === s.name).length;
      const closedMine = ganadas + lostMine;
      const conv = closedMine ? Math.round(ganadas / closedMine * 100) + '%' : '—';
      const alertas = [];
      if (withoutNext > 0) alertas.push({ texto: withoutNext + ' without next step', tone: 'ambar' });
      if (overdue > 0) alertas.push({ texto: overdue + ' overdue', tone: 'rojo' });
      const coaching = withoutNext >= 3 || overdue >= 3;
      return {
        ini: initials(s.name), nombre: s.name, conv,
        visitas, cotizaciones, siguientes: withNext,
        ganadas, valorGanado: fmtK(valorGanado),
        coaching, alertas,
        _open: mine.length,
      };
    })
      // show reps with any pipeline first; drop empty sellers to keep the sheet tidy
      .filter(v => v._open > 0 || v.ganadas > 0)
      .sort((a, b) => (b.coaching - a.coaching) || (b._open - a._open))
      .map(v => { delete v._open; return v; });

    // ---- 10. Losses by reason ----
    const reasonMap = {};
    lostRows.forEach(l => {
      const r = relName(l.lost_reason_id) || 'Not specified';
      reasonMap[r] = (reasonMap[r] || 0) + 1;
    });
    const perdidas = Object.keys(reasonMap)
      .map(r => ({ razon: r, n: reasonMap[r] }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6);

    return json({
      ok: true,
      data: {
        periodo, corteLabel,
        kpis, etapas,
        sinCotizar, cotizada,
        bant, vendedores, perdidas,
        perdidasTotal: lostCount,
      },
    });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
};

function weekNumber(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / DAY) + 1) / 7);
}
