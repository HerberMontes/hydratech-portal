// netlify/functions/odoo-crm-hoy.js
// "MI DÍA" — el cockpit del vendedor. Una sola cola ordenada por prioridad real.
//
// GET  /api/odoo-crm-hoy?email=<correo>   -> cola priorizada del vendedor
//      Combina en UNA lista, ordenada por score:
//        · actividades vencidas            (lo más urgente)
//        · actividades para hoy
//        · oportunidades SIN siguiente paso (la regla de oro rota)
//        · oportunidades FRÍAS             (tienen paso futuro pero llevan
//                                           demasiados días sin contacto real)
//      El score mezcla urgencia + monto + días sin contacto, para que una
//      oportunidad grande abandonada suba por encima de una chica de hoy.
//
// POST /api/odoo-crm-hoy
//      {action:"resultado", leadId, activityId?, tipo, resultado, nota,
//       sig:{tipo, fecha, nota}}
//         -> registra el toque en la bitácora del lead (mismo formato plano
//            que odoo-crm-plan para que el parser compartido lo entienda),
//            marca la actividad como hecha (si venía de una) y AGENDA el
//            siguiente paso. El frontend no deja guardar sin siguiente paso:
//            esa es la regla que separa un CRM vivo de una base de datos.
//      {action:"snooze", activityId, fecha}
//         -> pospone una actividad (mueve su fecha límite).
//
// Atribución por ETIQUETA del vendedor (misma convención que odoo-crm-plan.js).

import { executeKw, checkToken, json, diccionarioEtapas, parseBitacora } from "./lib/odoo.js";

const vendTag = (name) => "Vendedor · " + name;
const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const m2oName = (v) => (Array.isArray(v) ? v[1] : "");
const m2oId = (v) => (Array.isArray(v) ? v[0] : 0);
function mxn(n){ n=Number(n)||0; if(n>=1e6) return "$"+(n/1e6).toFixed(2).replace(/\.00$/,"")+"M"; if(n>=1e3) return "$"+Math.round(n/1e3)+"K"; return "$"+Math.round(n); }
function fechaCorta(s){ if(!s) return "—"; const d=new Date(s); if(isNaN(d)) return "—"; return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`; }
function tipoDe(cat, name){ name=(name||"").toLowerCase();
  if(cat==="phonecall"||name.includes("llam")) return "call";
  if(cat==="meeting"||name.includes("reuni")) return "meeting";
  if(name.includes("correo")||name.includes("email")||name.includes("mail")) return "email";
  return "todo"; }

/* ---------- vendedor por etiqueta (idéntico a odoo-crm-plan.js) ---------- */
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

async function tagDeVendedor(email){
  if(!email) return { tagId:0, nombre:"—" };
  let nombre="—";
  try{
    const emp = await executeKw("hr.employee","search_read",[[["work_email","=ilike",email]]],{fields:["name"],limit:1});
    if(emp&&emp.length) nombre=emp[0].name;
  }catch(e){}
  if(nombre==="—") return { tagId:0, nombre };
  let tagId=0;
  try{
    const tg = await executeKw("crm.tag","search_read",[[["name","=",vendTag(nombre)]]],{fields:["id"],limit:1});
    if(tg&&tg.length) tagId=tg[0].id;
    if(!tagId){
      const tgs = await executeKw("crm.tag","search_read",[[["name","like","Vendedor%"]]],{fields:["id","name"]}).catch(()=>[]);
      const objetivo=norm(nombre);
      const sinPref=(n)=>norm(n).replace(/^vendedor\s*[·:\-]?\s*/,"");
      let hit=tgs.find(t=>sinPref(t.name)===objetivo);
      if(!hit){ const toks=objetivo.split(" ").filter(Boolean); hit=tgs.find(t=>{const n=norm(t.name);return toks.length&&toks.every(k=>n.includes(k));}); }
      if(hit) tagId=hit.id;
    }
    if(!tagId) tagId = await executeKw("crm.tag","create",[{ name: vendTag(nombre) }]);
  }catch(e){}
  return { tagId, nombre };
}

async function ligarLeadAVendedor(leadId, email){
  try{
    const { tagId } = await tagDeVendedor(email);
    if(tagId && leadId) await executeKw("crm.lead","write",[[Number(leadId)],{ tag_ids:[[4, tagId]] }]);
    return tagId;
  }catch(e){ return 0; }
}

/* ---------- salud: umbral de días sin contacto según etapa ----------
   Cuanto más avanzada la oportunidad, más caro sale dejarla enfriar.
   ok    -> dentro del umbral
   warn  -> pasó el umbral         (ámbar)
   bad   -> pasó el doble          (rojo)                                */
const UMBRAL_POR_ETAPA = [
  // — flujo PROSPECTO (embudo de alta) —
  { nombres:["Por contactar"],                                     dias:2 },
  { nombres:["Cita agendada"],                                     dias:2 },
  { nombres:["Presentado"],                                        dias:3 },
  { nombres:["Alta en proceso"],                                   dias:5 },
  // — flujo OPORTUNIDAD (pipeline comercial) —
  { nombres:["Nuevo","New"],                                       dias:2 },
  { nombres:["Por cotizar","Qualified","Calificado"],              dias:3 },
  { nombres:["Cotización enviada","Propuesta","Cotizado","Proposition"], dias:3 },
  { nombres:["Negociación","Negotiation"],                         dias:4 },
];
const UMBRAL_DEFAULT = 5;

function saludDe(diasSinContacto, umbral){
  if(diasSinContacto == null) return { salud:"warn", umbral };
  if(diasSinContacto <= umbral)   return { salud:"ok",   umbral };
  if(diasSinContacto <= umbral*2) return { salud:"warn", umbral };
  return { salud:"bad", umbral };
}

/* ---------- crear una actividad (siguiente paso) ---------- */
async function crearSiguientePaso(leadId, sig){
  const mdl = await executeKw("ir.model","search_read",[[["model","=","crm.lead"]]],{fields:["id"],limit:1}).catch(()=>[]);
  const resModelId = mdl&&mdl.length ? mdl[0].id : false;
  const tipos = await executeKw("mail.activity.type","search_read",[[]],{fields:["id","name","category"]}).catch(()=>[]);
  const pick=(cat,kw)=>{const t=tipos.find(x=>x.category===cat||(x.name||"").toLowerCase().includes(kw));return t?t.id:false;};
  let typeId = sig.tipo==="call"?pick("phonecall","llam")
             : sig.tipo==="meeting"?pick("meeting","reuni")
             : sig.tipo==="email"?pick("","correo")
             : pick("","todo");
  if(!typeId && tipos.length) typeId = tipos[0].id;
  const vals = { res_id:Number(leadId), summary:sig.nota||"Siguiente paso", date_deadline:sig.fecha };
  if(resModelId) vals.res_model_id=resModelId; else vals.res_model="crm.lead";
  if(typeId) vals.activity_type_id=typeId;
  return executeKw("mail.activity","create",[vals]);
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok:false, error:"No autorizado." }, 401);

  /* ================= POST: acciones ================= */
  if (req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ ok:false, error:"JSON inválido." },400); }
    try{
      // --- posponer una actividad ---
      if (b.action === "snooze" && b.activityId && b.fecha) {
        await executeKw("mail.activity","write",[[Number(b.activityId)],{ date_deadline:b.fecha }]);
        return json({ ok:true });
      }

      // --- registrar el resultado de un toque + siguiente paso obligado ---
      if (b.action === "resultado" && b.leadId) {
        const TIPO = { call:"Llamada", email:"Correo", whatsapp:"WhatsApp", visit:"Visita", meeting:"Reunión", note:"Nota" };
        const RES  = { contacted:"Contactado", noresp:"Sin respuesta", waiting:"Pendiente de ellos", advanced:"Avanzó", cooled:"Se enfrió" };
        const tipoTxt = TIPO[b.tipo] || "Nota";
        const resTxt  = RES[b.resultado] || "";
        const nota = String(b.nota || "").trim();
        // Texto PLANO a propósito: mismo formato que odoo-crm-plan.js para que
        // el parser compartido (lib/odoo.js) lo lea en los reportes.
        let body = tipoTxt;
        if (resTxt) body += ` · ${resTxt}`;
        if (nota)   body += `\n${nota}`;
        await executeKw("crm.lead","message_post",[[Number(b.leadId)]],{ body, message_type:"comment" });

        // Si el toque venía de una actividad agendada, se marca hecha.
        if (b.activityId) {
          await executeKw("mail.activity","action_feedback",[[Number(b.activityId)]],
            { feedback: tipoTxt + (resTxt?(" · "+resTxt):"") }).catch(()=>{});
        }

        // Siguiente paso — el frontend lo exige antes de guardar.
        let sigId = null;
        if (b.sig && b.sig.fecha) {
          sigId = await crearSiguientePaso(b.leadId, b.sig).catch(()=>null);
        }

        await ligarLeadAVendedor(b.leadId, b.email);
        return json({ ok:true, sigId });
      }

      // --- agendar una actividad suelta (ej. Paso 1 de la cadencia al crear prospecto) ---
      if (b.action === "agendar" && b.leadId && b.sig && b.sig.fecha) {
        const id = await crearSiguientePaso(b.leadId, b.sig).catch(()=>null);
        await ligarLeadAVendedor(b.leadId, b.email);
        return json({ ok:true, id });
      }

      // --- mover de etapa (arrastre en el kanban) ---
      // La etapa llega por su nombre EN PANTALLA (español); se resuelve por el
      // diccionario multi-idioma comparando contra el nombre display.
      if (b.action === "etapa" && b.leadId && b.etapa) {
        let stageId = null;
        try{
          const dic = await diccionarioEtapas();
          const hit = Object.entries(dic.display).find(([,n])=>norm(n)===norm(b.etapa));
          if(hit) stageId = Number(hit[0]);
          if(!stageId){ const ids = dic.idsDe([b.etapa]); if(ids.length) stageId = ids[0]; }
        }catch(e){}
        if(!stageId){
          const st = await executeKw("crm.stage","search_read",[[["name","=",b.etapa]]],{fields:["id"],limit:1}).catch(()=>[]);
          if(st&&st.length) stageId=st[0].id;
        }
        if(!stageId) return json({ ok:false, error:"Etapa no encontrada: "+b.etapa },400);
        await executeKw("crm.lead","write",[[Number(b.leadId)],{ stage_id:stageId }]);
        await ligarLeadAVendedor(b.leadId, b.email);
        return json({ ok:true, stageId });
      }

      // --- CONVERSIÓN: cliente aprobado -> prospecto se vuelve oportunidad ---
      // 1· Se busca o crea el CLIENTE en Odoo (res.partner) con los datos del lead.
      // 2· El lead cambia a type=opportunity y se coloca en la etapa "Nuevo".
      // 3· La bitácora y la etiqueta del vendedor viajan con él (mismo registro).
      // 4· Se agenda el primer paso de la nueva oportunidad (obligatorio).
      if (b.action === "convertir" && b.leadId) {
        const L = await executeKw("crm.lead","read",
          [[Number(b.leadId)],["name","partner_name","contact_name","email_from","phone","partner_id"]]);
        const l = L && L[0];
        if(!l) return json({ ok:false, error:"Prospecto no encontrado." },404);

        // -- cliente: usar el ligado, buscar uno existente, o crearlo --
        let partnerId = Array.isArray(l.partner_id) ? l.partner_id[0] : 0;
        if(!partnerId){
          const nombreEmpresa = l.partner_name || l.contact_name || l.name;
          let found = [];
          if(l.email_from) found = await executeKw("res.partner","search_read",
            [[["email","=ilike",l.email_from]]],{fields:["id"],limit:1}).catch(()=>[]);
          if(!found.length && nombreEmpresa) found = await executeKw("res.partner","search_read",
            [[["name","=ilike",nombreEmpresa]]],{fields:["id"],limit:1}).catch(()=>[]);
          if(found.length) partnerId = found[0].id;
          else{
            partnerId = await executeKw("res.partner","create",[{
              name: nombreEmpresa, is_company: !!l.partner_name,
              phone: l.phone || false, email: l.email_from || false,
            }]);
            // Si hay empresa Y persona, el contacto se crea como hijo del cliente.
            if(l.partner_name && l.contact_name){
              await executeKw("res.partner","create",[{
                name:l.contact_name, parent_id:partnerId,
                phone:l.phone||false, email:l.email_from||false,
              }]).catch(()=>{});
            }
          }
        }

        // -- etapa "Nuevo" por su nombre EN ESPAÑOL (display), no por nombre base:
        //    evita confundirla con "Por contactar" cuando su nombre base es "New".
        let stageNuevo = null;
        try{
          const dic = await diccionarioEtapas();
          const hit = Object.entries(dic.display).find(([,n])=>norm(n)===norm("Nuevo"));
          if(hit) stageNuevo = Number(hit[0]);
        }catch(e){}
        if(!stageNuevo){
          const st = await executeKw("crm.stage","search_read",[[["name","=","Nuevo"]]],{fields:["id"],limit:1}).catch(()=>[]);
          if(st&&st.length) stageNuevo=st[0].id;
        }

        const w = { type:"opportunity", partner_id:partnerId };
        if(stageNuevo) w.stage_id = stageNuevo;
        await executeKw("crm.lead","write",[[Number(b.leadId)], w]);
        await executeKw("crm.lead","message_post",[[Number(b.leadId)]],
          { body:"Cliente aprobado ✔ Prospecto convertido a oportunidad desde el portal (etapa Nuevo).",
            message_type:"comment" }).catch(()=>{});
        await ligarLeadAVendedor(b.leadId, b.email);

        // Primer paso de la oportunidad recién nacida (el frontend lo exige).
        let sigId = null;
        if (b.sig && b.sig.fecha) sigId = await crearSiguientePaso(b.leadId, b.sig).catch(()=>null);
        return json({ ok:true, partnerId, sigId });
      }

      return json({ ok:false, error:"Acción no reconocida." },400);
    }catch(e){ return json({ ok:false, error:String(e.message||e) },500); }
  }

  /* ================= GET: la cola del día ================= */
  try{
    const url = new URL(req.url);
    const email = url.searchParams.get("email") || "";

    /* ---- FICHA de un lead: detalle + siguiente actividad + bitácora ---- */
    const fichaId = Number(url.searchParams.get("ficha") || 0);
    if (fichaId) {
      const L = await executeKw("crm.lead","read",
        [[fichaId],["name","type","partner_name","contact_name","partner_id","stage_id",
                    "expected_revenue","phone","email_from","create_date"]]);
      const l = L && L[0];
      if(!l) return json({ ok:false, error:"Lead no encontrado." },404);

      // siguiente actividad
      const acts = await executeKw("mail.activity","search_read",
        [[["res_model","=","crm.lead"],["res_id","=",fichaId]]],
        { fields:["id","summary","date_deadline","activity_type_id"], order:"date_deadline asc", limit:5 }).catch(()=>[]);
      const a = acts && acts[0];

      // bitácora: mensajes del chatter parseados con el parser compartido
      const msgs = await executeKw("mail.message","search_read",
        [[["model","=","crm.lead"],["res_id","=",fichaId],["message_type","in",["comment","email"]]]],
        { fields:["body","date"], order:"date desc", limit:40 }).catch(()=>[]);
      const ICONO = { "Llamada":"📞","Correo":"✉️","WhatsApp":"💬","Visita":"🚗","Reunión":"👥","Nota":"📝" };
      const timeline = [];
      for(const m of msgs){
        const p = parseBitacora(m.body, true);
        if(!p) continue;
        timeline.push({ icon:ICONO[p.tipo]||"📝", tipo:p.tipo, resultado:p.res||"", nota:p.nota||"",
                        fecha:fechaCorta(String(m.date||"").slice(0,10)) });
        if(timeline.length>=15) break;
      }

      let etapaDisplay = m2oName(l.stage_id) || "—";
      try{ const dic = await diccionarioEtapas(); const d = dic.display[m2oId(l.stage_id)]; if(d) etapaDisplay=d; }catch(e){}

      const esAlta = norm(etapaDisplay)===norm("Alta en proceso");
      return json({ ok:true, ficha:{
        leadId:l.id,
        flujo: l.type==="lead" ? "prospecto" : "oportunidad",
        puedeConvertir: l.type==="lead" && esAlta,
        nombre:l.name||"—",
        cliente:(l.partner_name||m2oName(l.partner_id)||l.contact_name||"—"),
        contacto:l.contact_name||"", telefono:l.phone||"", correo:l.email_from||"",
        etapa:etapaDisplay,
        monto:mxn(l.expected_revenue), montoNum:Number(l.expected_revenue)||0,
        sig: a ? { activityId:a.id, resumen:a.summary||m2oName(a.activity_type_id)||"Siguiente paso",
                   fecha:a.date_deadline||"", fechaTxt:fechaCorta(a.date_deadline) } : null,
        timeline,
      }});
    }

    const { tagId, nombre } = await tagDeVendedor(email);
    const today = fmt(new Date());
    const hoyMs = Date.parse(today+"T00:00:00Z");

    const out = { vendedor:nombre, tagId, hoyISO:today,
                  vencidas:0, paraHoy:0, sinPaso:0, frias:0,
                  cola:[], proximas:[] };
    if(!tagId) return json({ ok:true, dia:out });

    // Etapas: excluir ganadas por ID (robusto a idiomas / renombres).
    let idsGanado = [];
    let etapasDic = null;
    try { etapasDic = await diccionarioEtapas(); idsGanado = etapasDic.idsDe(["Ganado","Won"]); } catch(e){}

    // AMBOS FLUJOS del vendedor: prospectos (type=lead, embudo de alta) y
    // oportunidades (type=opportunity, pipeline comercial). Mi Día los vigila juntos.
    const dominio = [["tag_ids","in",[tagId]],["active","=",true]];
    if(idsGanado.length) dominio.push(["stage_id","not in",idsGanado]);
    const leads = await executeKw("crm.lead","search_read",[dominio],
      { fields:["id","name","type","partner_name","contact_name","partner_id","stage_id","expected_revenue","create_date","priority"], limit:500 });
    const leadIds = leads.map(l=>l.id);
    const leadById = {}; leads.forEach(l=>leadById[l.id]=l);

    // Tipos de actividad (para el icono)
    const tipos = await executeKw("mail.activity.type","search_read",[[]],{fields:["id","name","category"]}).catch(()=>[]);
    const tipoById = {}; tipos.forEach(t=>tipoById[t.id]={cat:t.category,name:t.name});

    // Actividades pendientes
    let acts = [];
    if(leadIds.length){
      acts = await executeKw("mail.activity","search_read",
        [[["res_model","=","crm.lead"],["res_id","in",leadIds]]],
        { fields:["id","activity_type_id","summary","date_deadline","res_id"], order:"date_deadline asc", limit:200 }).catch(()=>[]);
    }
    const actsByLead = {}; acts.forEach(a=>{ (actsByLead[a.res_id]=actsByLead[a.res_id]||[]).push(a); });

    // ÚLTIMO CONTACTO por lead: fecha del último mensaje humano en el chatter.
    // (comment = bitácora del portal o nota en Odoo; email = correo real)
    const ultimo = {};
    if(leadIds.length){
      const msgs = await executeKw("mail.message","search_read",
        [[["model","=","crm.lead"],["res_id","in",leadIds],["message_type","in",["comment","email"]]]],
        { fields:["res_id","date"], order:"date desc", limit:1000 }).catch(()=>[]);
      msgs.forEach(m=>{ if(!ultimo[m.res_id]) ultimo[m.res_id]=m.date; });
    }

    // Días sin contacto + umbral según etapa
    const infoSalud = (l) => {
      const base = ultimo[l.id] || l.create_date || "";
      let dias = null;
      if(base){ const t = Date.parse(String(base).replace(" ","T")+"Z"); if(!isNaN(t)) dias = Math.max(0, Math.floor((hoyMs - t)/86400000)); }
      let umbral = UMBRAL_DEFAULT;
      if(etapasDic){
        const sid = m2oId(l.stage_id);
        for(const u of UMBRAL_POR_ETAPA){ if(etapasDic.canonicaDe(sid, u.nombres)){ umbral = u.dias; break; } }
      }
      const s = saludDe(dias, umbral);
      return { dias, ...s };
    };

    // Score: urgencia (base por tipo) + monto (log) + días de abandono.
    const boostMonto = (m)=>{ m=Number(m)||0; return m<=0?0:Math.min(20, Math.log10(m)*4); };

    const esAltaEnProceso = (l) => {
      if(etapasDic && etapasDic.canonicaDe(m2oId(l.stage_id), ["Alta en proceso"])) return true;
      return norm(m2oName(l.stage_id)) === norm("Alta en proceso");
    };

    const item = (l, extra) => ({
      leadId:l.id,
      flujo: l.type === "lead" ? "prospecto" : "oportunidad",
      // El prospecto en "Alta en proceso" puede convertirse: cliente aprobado
      // -> se crea en Odoo y nace la oportunidad en "Nuevo".
      puedeConvertir: l.type === "lead" && esAltaEnProceso(l),
      oportunidad:l.name||"Oportunidad",
      cliente:(l.partner_name||m2oName(l.partner_id)||l.contact_name||"—"),
      etapa:m2oName(l.stage_id)||"—",
      monto:mxn(l.expected_revenue),
      montoNum:Number(l.expected_revenue)||0,
      ...extra,
    });

    leads.forEach(l=>{
      const la = (actsByLead[l.id]||[]).slice().sort((x,y)=>String(x.date_deadline||"").localeCompare(String(y.date_deadline||"")));
      const sal = infoSalud(l);
      const comun = { diasSinContacto:sal.dias, salud:sal.salud, umbral:sal.umbral };

      if(la.length){
        const a = la[0], dd = a.date_deadline || "";
        const tt = tipoById[m2oId(a.activity_type_id)] || {};
        const actInfo = { activityId:a.id, actTipo:tipoDe(tt.cat,tt.name), resumen:a.summary||tt.name||"Actividad", fechaVence:dd, fechaTxt:fechaCorta(dd) };

        if(dd < today){
          const retraso = Math.max(1, Math.floor((hoyMs - Date.parse(dd+"T00:00:00Z"))/86400000));
          out.vencidas++;
          out.cola.push(item(l,{ ...comun, ...actInfo, bucket:"vencida",
            razon:`Vencida hace ${retraso===1?"1 día":retraso+" días"}`,
            score: 100 + Math.min(30,retraso) + boostMonto(l.expected_revenue) + Math.min(15, sal.dias||0) }));
        } else if(dd === today){
          out.paraHoy++;
          out.cola.push(item(l,{ ...comun, ...actInfo, bucket:"hoy",
            razon:"Programada para hoy",
            score: 80 + boostMonto(l.expected_revenue) + Math.min(15, sal.dias||0) }));
        } else if(sal.salud==="bad"){
          // Tiene paso futuro pero lleva DEMASIADO sin contacto: se está enfriando.
          out.frias++;
          out.cola.push(item(l,{ ...comun, ...actInfo, bucket:"fria",
            razon:`${sal.dias} días sin contacto (límite ${sal.umbral} en ${m2oName(l.stage_id)||"esta etapa"})`,
            score: 50 + boostMonto(l.expected_revenue) + Math.min(25, sal.dias||0) }));
        } else {
          out.proximas.push(item(l,{ ...comun, ...actInfo, bucket:"proxima", razon:"Al corriente" }));
        }
      } else {
        // SIN siguiente paso: la regla de oro rota. Siempre entra a la cola.
        out.sinPaso++;
        out.cola.push(item(l,{ ...comun, bucket:"sinpaso",
          activityId:null, actTipo:"todo", resumen:"Definir siguiente paso", fechaVence:"", fechaTxt:"",
          razon: sal.dias!=null ? `Sin siguiente paso · ${sal.dias===0?"contacto hoy":sal.dias+" días sin contacto"}` : "Sin siguiente paso",
          score: 70 + boostMonto(l.expected_revenue) + Math.min(20, sal.dias||0) }));
      }
    });

    out.cola.sort((a,b)=>b.score-a.score);
    out.proximas.sort((a,b)=>String(a.fechaVence).localeCompare(String(b.fechaVence)));

    // TABLERO para el kanban: TODOS los abiertos con su etapa display y salud.
    const displayEtapa = (l)=>{
      if(etapasDic){ const d=etapasDic.display[m2oId(l.stage_id)]; if(d) return d; }
      return m2oName(l.stage_id)||"—";
    };
    out.tablero = leads.map(l=>{
      const sal = infoSalud(l);
      return item(l,{ etapa:displayEtapa(l), salud:sal.salud, diasSinContacto:sal.dias });
    });

    return json({ ok:true, dia:out });
  }catch(e){ return json({ ok:false, error:String(e.message||e) },500); }
};
