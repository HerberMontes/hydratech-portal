// netlify/functions/odoo-crm-actividad.js
// GET /api/odoo-crm-actividad?semana=N  -> actividad de la semana por vendedor.
// Lee las BITÁCORAS que los vendedores registran (mail.message en crm.lead) y las
// clasifica por tipo (Llamada/Correo/WhatsApp/Visita/Reunión/Nota) y resultado.
// Atribución por ETIQUETA "Vendedor · <Nombre>", igual que el resto del CRM.
import { executeKw, checkToken, json } from "./lib/odoo.js";

const VEND_PREFIX = "Vendedor · ";
const LEAD_STAGES = ["Por contactar", "Cita agendada", "Presentado", "Alta en proceso"];
const OPP_STAGES  = ["Nuevo", "Por cotizar", "Cotización enviada"];
const S_GANADO = "Ganado";
const UMBRAL_ESTANCADO = 14; // días en la misma etapa para marcar "estancado"

const TIPOS = ["Llamada", "Correo", "WhatsApp", "Visita", "Reunión", "Nota"];
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const DAY = 24*60*60*1000;

const m2oName = (v) => Array.isArray(v) ? v[1] : "";
const m2oId   = (v) => Array.isArray(v) ? v[0] : (v||false);
const initials = (n) => { const p=String(n||"").trim().split(/\s+/).filter(Boolean); return !p.length?"··":p.length===1?p[0].slice(0,2).toUpperCase():(p[0][0]+p[1][0]).toUpperCase(); };

function fmtDia(d){ return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`; }
function odooDate(d){ return d.toISOString().slice(0,10); }
function weekNumber(d){ const t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())); const dn=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-dn); const ys=new Date(Date.UTC(t.getUTCFullYear(),0,1)); return Math.ceil((((t-ys)/DAY)+1)/7); }

// Semana en curso (lunes–domingo), corrida N semanas hacia atrás con ?semana=N.
function ventana(offset){
  const now=new Date();
  const dow=now.getUTCDay()||7; // 1=lun..7=dom
  const mon=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  mon.setUTCDate(mon.getUTCDate()-(dow-1)-offset*7);
  const sun=new Date(mon); sun.setUTCDate(sun.getUTCDate()+6);
  return { mon, sun, now:now.getTime() };
}

// Extrae tipo y resultado del cuerpo de la bitácora: "<b>Llamada</b> · <span>Contactado</span><br>nota"
function parseBitacora(body){
  if(!body) return { tipo:null, res:null };
  const mb=body.match(/<b>([^<]+)<\/b>/);
  const ms=body.match(/<span>([^<]+)<\/span>/);
  return { tipo: mb?mb[1].trim():null, res: ms?ms[1].trim():null };
}
function diasEntre(dtStr, nowMs){
  if(!dtStr) return null;
  const t=Date.parse(String(dtStr).replace(" ","T")+"Z");
  if(isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t)/DAY));
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok:false, error:"No autorizado." }, 401);
  try{
    const url = new URL(req.url);
    const offset = Math.max(0, parseInt(url.searchParams.get("semana")||"0",10)||0);
    const w = ventana(offset);
    const startStr = odooDate(w.mon)+" 00:00:00";
    const endStr   = odooDate(w.sun)+" 23:59:59";
    const today    = odooDate(new Date(w.now));
    const periodo  = `Semana ${weekNumber(w.mon)} · ${fmtDia(w.mon)}–${fmtDia(w.sun)} ${w.sun.getUTCFullYear()}`;
    const corteLabel = `Al ${fmtDia(new Date(w.now))} ${new Date(w.now).getUTCFullYear()}`;

    // 1) Vendedores (etiquetas)
    const tags = await executeKw("crm.tag","search_read",
      [[["name","like",VEND_PREFIX+"%"]]],{fields:["id","name"]});
    const sellers = tags.map(t=>({ tagId:t.id, name:t.name.slice(VEND_PREFIX.length).trim() }));
    const tagName = {}; sellers.forEach(s=>tagName[s.tagId]=s.name);
    const allTagIds = sellers.map(s=>s.tagId);

    const base = () => ({ avances:0, porTipo:Object.fromEntries(TIPOS.map(t=>[t,0])),
      contactado:0, sinRespuesta:0, pendiente:0, avanzo:0, enfrio:0,
      movidas:0, ganadas:0, abiertos:0, sinSiguiente:0, estancados:0, ultimo:null });
    const acc = {}; sellers.forEach(s=>acc[s.name]=base());

    if(!allTagIds.length){
      return json({ ok:true, data:{ periodo, corteLabel, equipo:base(), vendedores:[] }});
    }

    // 2) Leads de todos los vendedores (incluye inactivos para contar ganadas/perdidas)
    const leads = await executeKw("crm.lead","search_read",
      [[["tag_ids","in",allTagIds]]],
      { fields:["id","tag_ids","stage_id","active","type","date_last_stage_update","activity_date_deadline","expected_revenue"],
        limit:3000, context:{ active_test:false } });
    const leadVendor = {};   // leadId -> nombre vendedor
    const leadIds = [];
    leads.forEach(l=>{
      const vt = (l.tag_ids||[]).find(id=>tagName[id]);
      if(!vt) return;
      const v = tagName[vt];
      leadVendor[l.id] = v;
      leadIds.push(l.id);
      const a = acc[v]; if(!a) return;
      const etapa = m2oName(l.stage_id);
      const abierto = l.active && etapa !== S_GANADO;
      if(abierto){
        a.abiertos++;
        if(!l.activity_date_deadline) a.sinSiguiente++;
        const dEt = diasEntre(l.date_last_stage_update, w.now);
        if(dEt!==null && dEt>UMBRAL_ESTANCADO) a.estancados++;
      }
      // Movimientos de etapa dentro de la semana (señal de avance real)
      if(l.date_last_stage_update && l.date_last_stage_update>=startStr && l.date_last_stage_update<=endStr){
        a.movidas++;
        if(etapa===S_GANADO) a.ganadas++;
      }
    });

    // 3) Bitácoras (mensajes) de la semana sobre esos leads
    let msgs = [];
    if(leadIds.length){
      msgs = await executeKw("mail.message","search_read",
        [[["model","=","crm.lead"],["res_id","in",leadIds],
          ["date",">=",startStr],["date","<=",endStr],["message_type","=","comment"]]],
        { fields:["body","date","res_id"], limit:5000, order:"date asc" }).catch(()=>[]);
    }
    msgs.forEach(mm=>{
      const v = leadVendor[mm.res_id]; if(!v) return;
      const { tipo, res } = parseBitacora(mm.body);
      if(!tipo || TIPOS.indexOf(tipo)<0) return;   // solo cuentan bitácoras reales
      const a = acc[v]; if(!a) return;
      a.avances++;
      a.porTipo[tipo]++;
      if(res==="Contactado") a.contactado++;
      else if(res==="Sin respuesta") a.sinRespuesta++;
      else if(res==="Pendiente de ellos") a.pendiente++;
      else if(res==="Avanzó") a.avanzo++;
      else if(res==="Se enfrió") a.enfrio++;
      if(!a.ultimo || mm.date>a.ultimo) a.ultimo = mm.date;
    });

    // 4) Arma vendedores + coaching
    const vendedores = sellers.map(s=>{
      const a = acc[s.name];
      const diasSin = a.ultimo ? diasEntre(a.ultimo, w.now) : null;
      const alertas = [];
      if(a.avances===0) alertas.push({ texto:"Sin actividad esta semana", tone:"rojo" });
      if(a.sinSiguiente>0) alertas.push({ texto:a.sinSiguiente+" sin siguiente paso", tone:"ambar" });
      if(a.estancados>0) alertas.push({ texto:a.estancados+" estancados +"+UMBRAL_ESTANCADO+"d", tone:"ambar" });
      const coaching = a.avances===0 || a.sinSiguiente>=3 || (diasSin!==null && diasSin>=4);
      return {
        nombre:s.name, ini:initials(s.name),
        avances:a.avances, porTipo:a.porTipo,
        contactado:a.contactado, sinRespuesta:a.sinRespuesta, pendiente:a.pendiente, avanzo:a.avanzo, enfrio:a.enfrio,
        movidas:a.movidas, ganadas:a.ganadas,
        abiertos:a.abiertos, sinSiguiente:a.sinSiguiente, estancados:a.estancados,
        diasSinRegistrar:diasSin,
        coaching, alertas,
      };
    })
    .sort((x,y)=> (y.coaching-x.coaching) || (y.avances-x.avances));

    // 5) Totales del equipo
    const equipo = base();
    delete equipo.ultimo;
    vendedores.forEach(v=>{
      equipo.avances += v.avances;
      TIPOS.forEach(t=>equipo.porTipo[t]+=v.porTipo[t]);
      equipo.contactado+=v.contactado; equipo.sinRespuesta+=v.sinRespuesta; equipo.pendiente+=v.pendiente;
      equipo.avanzo+=v.avanzo; equipo.enfrio+=v.enfrio;
      equipo.movidas+=v.movidas; equipo.ganadas+=v.ganadas;
      equipo.abiertos+=v.abiertos; equipo.sinSiguiente+=v.sinSiguiente; equipo.estancados+=v.estancados;
    });
    equipo.repsActivos = vendedores.filter(v=>v.avances>0).length;
    equipo.repsCoaching = vendedores.filter(v=>v.coaching).length;
    equipo.total = vendedores.length;

    return json({ ok:true, data:{ periodo, corteLabel, equipo, vendedores } });
  }catch(e){
    return json({ ok:false, error:String(e.message||e) }, 500);
  }
};
