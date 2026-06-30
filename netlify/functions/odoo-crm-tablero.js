// netlify/functions/odoo-crm-tablero.js
// GET /api/odoo-crm-tablero?semana=<ISO week>  -> resumen del equipo para dirección.
// Encuentra a los vendedores por sus ETIQUETAS "Vendedor · <Nombre>" (sin usuarios de Odoo).
import { executeKw, checkToken, json } from "./lib/odoo.js";

const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const m2oName = (v) => (Array.isArray(v) ? v[1] : "");
function mxn(n){ n=Number(n)||0; if(n>=1e6) return "$"+(n/1e6).toFixed(2).replace(/\.00$/,"")+"M"; if(n>=1e3) return "$"+Math.round(n/1e3)+"K"; return "$"+Math.round(n); }

function mondayOfISOWeek(week, year){
  const s=new Date(Date.UTC(year,0,1+(week-1)*7)); const dow=s.getUTCDay(); const m=new Date(s);
  if(dow<=4) m.setUTCDate(s.getUTCDate()-(dow===0?6:dow-1)); else m.setUTCDate(s.getUTCDate()+(8-dow));
  m.setUTCHours(0,0,0,0); return m;
}
function isoWeekNum(d){ const t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())); const day=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-day); const y=new Date(Date.UTC(t.getUTCFullYear(),0,1)); return Math.ceil(((t-y)/86400000+1)/7); }
function rango(semana, year){
  let mon;
  if(semana && Number(semana)>0) mon=mondayOfISOWeek(Number(semana),year);
  else{ const now=new Date(); const dow=now.getUTCDay()||7; mon=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-(dow-1)-7)); mon.setUTCHours(0,0,0,0); }
  const sun=new Date(mon); sun.setUTCDate(mon.getUTCDate()+6);
  const f=(d)=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
  return { start:f(mon)+" 00:00:00", end:f(sun)+" 23:59:59",
    num:isoWeekNum(mon), label:`Semana ${isoWeekNum(mon)} · ${mon.getUTCDate()}–${sun.getUTCDate()} ${MESES[sun.getUTCMonth()]} ${sun.getUTCFullYear()}` };
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok:false, error:"No autorizado." }, 401);
  const url = new URL(req.url);
  const W = rango(url.searchParams.get("semana"), new Date().getUTCFullYear());

  try{
    // Vendedores = etiquetas "Vendedor · ..."
    const tags = await executeKw("crm.tag","search_read",
      [[["name","like","Vendedor · %"]]], { fields:["id","name"], limit:25 });

    const reps = [];
    for (const tg of tags) {
      const dom = ["tag_ids","in",[tg.id]];
      const nombre = tg.name.replace(/^Vendedor · /, "");

      // Creadas en la semana (pipeline + nuevas oportunidades)
      const creadas = await executeKw("crm.lead","search_read",
        [[dom, ["create_date",">=",W.start], ["create_date","<=",W.end]]],
        { fields:["expected_revenue","type"] }).catch(()=>[]);
      const pipeline = creadas.reduce((s,r)=>s+(r.expected_revenue||0),0);
      const nuevas = creadas.filter(r=>r.type==="opportunity").length;

      // Ganadas en la semana
      const ganadas = await executeKw("crm.lead","search_count",
        [[dom, ["probability","=",100], ["date_closed",">=",W.start], ["date_closed","<=",W.end]]]).catch(()=>0);

      // Coaching (estado actual)
      let sinPaso=0, vencidas=0;
      try{ sinPaso = await executeKw("crm.lead","search_count",[[dom,["type","=","opportunity"],["active","=",true],["activity_ids","=",false]]]); }catch(e){}
      try{ vencidas = await executeKw("crm.lead","search_count",[[dom,["active","=",true],["activity_state","=","overdue"]]]); }catch(e){}

      // Actividad (mail.message sobre los leads del vendedor)
      let actividades = 0, equipo = "—";
      try{
        const ids = await executeKw("crm.lead","search",[[dom]],{limit:1000});
        if(ids.length){
          actividades = await executeKw("mail.message","search_count",
            [[["model","=","crm.lead"],["res_id","in",ids],["mail_activity_type_id","!=",false],
              ["date",">=",W.start],["date","<=",W.end]]]);
        }
        const t = await executeKw("crm.lead","search_read",[[dom,["team_id","!=",false]]],{fields:["team_id"],limit:1});
        if(t&&t.length) equipo = m2oName(t[0].team_id) || "—";
      }catch(e){}

      reps.push({ nombre, equipo, actividades, nuevas, pipeline:mxn(pipeline), ganadas, sinPaso, vencidas });
    }

    // Quienes requieren feedback primero
    reps.sort((a,b)=>((b.sinPaso+ (b.vencidas>2?1:0)) - (a.sinPaso+(a.vencidas>2?1:0))) || a.nombre.localeCompare(b.nombre));

    return json({ ok:true, reps, rango:W.label });
  }catch(e){ return json({ ok:false, error:String(e.message||e) }, 500); }
};
