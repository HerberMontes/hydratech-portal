// netlify/functions/odoo-crm-plan.js
// GET  /api/odoo-crm-plan?email=<correo del vendedor>  -> su plan (actividades + opps sin paso)
// POST /api/odoo-crm-plan  {action:"done", activityId}            -> marca actividad hecha
// POST /api/odoo-crm-plan  {action:"schedule", leadId, tipo, summary, date} -> agenda siguiente paso
// Atribución por ETIQUETA del vendedor (sin usuario de Odoo). Misma convención que odoo-crm-lead.js.
import { executeKw, checkToken, json, diccionarioEtapas } from "./lib/odoo.js";

const vendTag = (name) => "Vendedor · " + name;
const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const m2oName = (v) => (Array.isArray(v) ? v[1] : "");
function mxn(n){ n=Number(n)||0; if(n>=1e6) return "$"+(n/1e6).toFixed(2).replace(/\.00$/,"")+"M"; if(n>=1e3) return "$"+Math.round(n/1e3)+"K"; return "$"+Math.round(n); }
function tipoDe(cat, name){ name=(name||"").toLowerCase();
  if(cat==="phonecall"||name.includes("llam")) return "call";
  if(cat==="meeting"||name.includes("reuni")) return "meeting";
  if(name.includes("correo")||name.includes("email")||name.includes("mail")) return "email";
  return "todo"; }

// Resuelve correo -> empleado -> etiqueta del vendedor.
// ROBUSTO: correo sin distinguir mayúsculas, etiqueta tolerante a acentos y
// apellidos, y si la etiqueta no existe se CREA (así el vendedor queda ligado
// desde su primer registro y el reporte siempre lo encuentra).
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
    // 1) exacta
    const tg = await executeKw("crm.tag","search_read",[[["name","=",vendTag(nombre)]]],{fields:["id"],limit:1});
    if(tg&&tg.length) tagId=tg[0].id;
    // 2) tolerante (acentos / mayúsculas / apellidos extra)
    if(!tagId){
      const tgs = await executeKw("crm.tag","search_read",[[["name","like","Vendedor%"]]],{fields:["id","name"]}).catch(()=>[]);
      const objetivo=norm(nombre);
      const sinPref=(n)=>norm(n).replace(/^vendedor\s*[·:\-]?\s*/,"");
      let hit=tgs.find(t=>sinPref(t.name)===objetivo);
      if(!hit){ const toks=objetivo.split(" ").filter(Boolean); hit=tgs.find(t=>{const n=norm(t.name);return toks.length&&toks.every(k=>n.includes(k));}); }
      if(hit) tagId=hit.id;
    }
    // 3) si no existe, se crea
    if(!tagId) tagId = await executeKw("crm.tag","create",[{ name: vendTag(nombre) }]);
  }catch(e){}
  return { tagId, nombre };
}

// LIGA el lead al vendedor: le agrega su etiqueta si no la tiene (operación 4 de
// Odoo = "link", idempotente). Se llama en cada registro de actividad para que
// TODO lo que el vendedor toque quede atribuido y el reporte lo pueda extraer,
// incluso en leads creados directamente en Odoo (sin etiqueta original).
async function ligarLeadAVendedor(leadId, email){
  try{
    const { tagId } = await tagDeVendedor(email);
    if(tagId && leadId) await executeKw("crm.lead","write",[[Number(leadId)],{ tag_ids:[[4, tagId]] }]);
    return tagId;
  }catch(e){ return 0; }
}

export default async (req) => {
  if (!checkToken(req)) return json({ ok:false, error:"No autorizado." }, 401);

  /* ---------- POST: acciones ---------- */
  if (req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ ok:false, error:"JSON inválido." },400); }
    try{
      if (b.action === "done" && b.activityId) {
        await executeKw("mail.activity","action_feedback",[[Number(b.activityId)]],
          { feedback: b.summary || "Hecho desde el portal" });
        return json({ ok:true });
      }
      if (b.action === "schedule" && b.leadId) {
        // res_model_id de crm.lead
        const mdl = await executeKw("ir.model","search_read",[[["model","=","crm.lead"]]],{fields:["id"],limit:1});
        const resModelId = mdl&&mdl.length ? mdl[0].id : false;
        // tipo de actividad
        const tipos = await executeKw("mail.activity.type","search_read",[[]],{fields:["id","name","category"]}).catch(()=>[]);
        const pick = (cat,kw)=>{ const t=tipos.find(x=>x.category===cat||(x.name||"").toLowerCase().includes(kw)); return t?t.id:false; };
        let typeId = b.tipo==="call"?pick("phonecall","llam"):b.tipo==="meeting"?pick("meeting","reuni"):pick("","todo");
        if(!typeId && tipos.length) typeId = tipos[0].id;
        const hoy = new Date(); const venc = b.date || fmt(new Date(Date.UTC(hoy.getUTCFullYear(),hoy.getUTCMonth(),hoy.getUTCDate()+2)));
        const vals = { res_id:Number(b.leadId), summary:b.summary||"Siguiente paso", date_deadline:venc };
        if(resModelId) vals.res_model_id=resModelId; else vals.res_model="crm.lead";
        if(typeId) vals.activity_type_id=typeId;
        const id = await executeKw("mail.activity","create",[vals]);  // user_id por defecto = usuario de la API
        await ligarLeadAVendedor(b.leadId, b.email);
        return json({ ok:true, id });
      }
      if (b.action === "calificar" && b.leadId) {
        const bant = b.bant || {};
        const vals = {};
        // Etapa "Por cotizar" resuelta con el diccionario multi-idioma
        // (tolera etapas renombradas cuyo nombre base quedó en otro idioma).
        try {
          const dic = await diccionarioEtapas();
          const ids = dic.idsDe(["Por cotizar", "Qualified", "Calificado"]);
          if (ids.length) vals.stage_id = ids[0];
        } catch (e) {}
        // Prioridad automática según la calificación (el "semáforo" del BANT).
        const score = ["b","a","n","t"].reduce((s,k)=>s+(Number(bant[k])||0),0); // 0..8
        vals.priority = score>=6 ? "3" : score>=4 ? "2" : "1";
        await executeKw("crm.lead","write",[[Number(b.leadId)], vals]);
        // Registra la calificación en el historial (chatter), mejor esfuerzo.
        try{
          const et = (v)=>["Sin definir/Bajo","Medio","Alto"][Number(v)||0] || "—";
          const body = `Calificación BANT\nPresupuesto: ${et(bant.b)} · Autoridad: ${et(bant.a)} · Necesidad: ${et(bant.n)} · Plazo: ${et(bant.t)}\nMovida a Por cotizar.`;
          await executeKw("crm.lead","message_post",[[Number(b.leadId)]],{ body, message_type:"comment" });
        }catch(e){}
        await ligarLeadAVendedor(b.leadId, b.email);
        return json({ ok:true });
      }
      // ---- BITÁCORA: documenta lo que hizo el vendedor para empujar el lead/oportunidad ----
      if (b.action === "bitacora" && b.leadId) {
        const TIPO = { call:"Llamada", email:"Correo", whatsapp:"WhatsApp", visit:"Visita", meeting:"Reunión", note:"Nota" };
        const RES  = { contacted:"Contactado", noresp:"Sin respuesta", waiting:"Pendiente de ellos", advanced:"Avanzó", cooled:"Se enfrió" };
        const tipoTxt = TIPO[b.tipo] || "Nota";
        const resTxt  = RES[b.resultado] || "";
        const nota = String(b.nota || "").trim();
        // TEXTO PLANO a propósito: message_post por API escapa el HTML según la
        // versión de Odoo (en la base real los <b> quedaron como &lt;b&gt; y se
        // veían literales en el chatter). En plano se lee limpio en Odoo y el
        // parser compartido (lib/odoo.js) lo entiende igual.
        let body = tipoTxt;
        if (resTxt) body += ` · ${resTxt}`;
        if (nota)   body += `\n${nota}`;
        await executeKw("crm.lead","message_post",[[Number(b.leadId)]],{ body, message_type:"comment" });
        // LIGA escritura↔lectura: garantiza la etiqueta del vendedor en el lead
        // para que este avance salga en el reporte (aunque el lead se haya
        // creado directo en Odoo, sin etiqueta).
        await ligarLeadAVendedor(b.leadId, b.email);

        // Siguiente paso (opcional): crea la actividad agendada.
        let schedId = null;
        if (b.sigFecha) {
          const mdl = await executeKw("ir.model","search_read",[[["model","=","crm.lead"]]],{fields:["id"],limit:1}).catch(()=>[]);
          const resModelId = mdl&&mdl.length ? mdl[0].id : false;
          const tipos = await executeKw("mail.activity.type","search_read",[[]],{fields:["id","name","category"]}).catch(()=>[]);
          const pick=(cat,kw)=>{const t=tipos.find(x=>x.category===cat||(x.name||"").toLowerCase().includes(kw));return t?t.id:false;};
          let typeId = b.sigTipo==="call"?pick("phonecall","llam"):b.sigTipo==="meeting"?pick("meeting","reuni"):b.sigTipo==="email"?pick("","correo"):pick("","todo");
          if(!typeId && tipos.length) typeId = tipos[0].id;
          const vals = { res_id:Number(b.leadId), summary:b.sigNota||("Siguiente paso: "+tipoTxt), date_deadline:b.sigFecha };
          if(resModelId) vals.res_model_id=resModelId; else vals.res_model="crm.lead";
          if(typeId) vals.activity_type_id=typeId;
          schedId = await executeKw("mail.activity","create",[vals]).catch(()=>null);
        }
        return json({ ok:true, schedId });
      }
      return json({ ok:false, error:"Acción no reconocida." },400);
    }catch(e){ return json({ ok:false, error:String(e.message||e) },500); }
  }

  /* ---------- GET: el plan del vendedor ---------- */
  try{
    const url = new URL(req.url);
    const email = url.searchParams.get("email") || "";
    const { tagId, nombre } = await tagDeVendedor(email);
    const dominio = ["tag_ids","in",[tagId||-1]];
    const today = fmt(new Date());

    const plan = { vendedor:nombre, tagId, emailBuscado:email, hoy:0, vencidas:0, sinPaso:0, actividades:[], sinPasoLista:[], porCalificar:[], items:[] };
    if(!tagId) return json({ ok:true, plan });

    // Leads del vendedor (para contexto y para mapear actividades)
    const leads = await executeKw("crm.lead","search_read",
      [[dominio, ["active","=",true]]],
      { fields:["id","name","partner_name","contact_name","partner_id","stage_id","expected_revenue","type"], limit:500 });
    const leadById = {}; leads.forEach(l=>leadById[l.id]=l);
    const leadIds = leads.map(l=>l.id);

    // Tipos de actividad (para el icono)
    const tipos = await executeKw("mail.activity.type","search_read",[[]],{fields:["id","name","category"]}).catch(()=>[]);
    const tipoById = {}; tipos.forEach(t=>tipoById[t.id]={cat:t.category,name:t.name});

    // Actividades pendientes sobre esos leads
    let acts = [];
    if(leadIds.length){
      acts = await executeKw("mail.activity","search_read",
        [[["res_model","=","crm.lead"],["res_id","in",leadIds]]],
        { fields:["id","activity_type_id","summary","date_deadline","res_id"], order:"date_deadline asc", limit:100 }).catch(()=>[]);
    }
    acts.forEach(a=>{
      const lead = leadById[a.res_id] || {};
      const dd = a.date_deadline || "";
      let estado="ok", fecha="";
      if(dd < today){ estado="due"; plan.vencidas++; fecha="Vencida · "+fechaCorta(dd); }
      else if(dd === today){ estado="today"; plan.hoy++; fecha="Hoy"; }
      else { estado="ok"; fecha=fechaCorta(dd); }
      const tt = tipoById[Array.isArray(a.activity_type_id)?a.activity_type_id[0]:0] || {};
      plan.actividades.push({
        id:a.id, leadId:a.res_id, tipo:tipoDe(tt.cat,tt.name),
        oportunidad: lead.name || m2oName(a.activity_type_id) || "Actividad",
        etapa: m2oName(lead.stage_id) || "",
        cliente: (lead.partner_name || m2oName(lead.partner_id) || lead.contact_name || "—") + (lead.stage_id?(" · "+m2oName(lead.stage_id)):""),
        monto: mxn(lead.expected_revenue),
        resumen: a.summary || (tt.name || "Actividad"),
        fecha, estado,
      });
    });

    // Oportunidades sin siguiente paso (abiertas, sin actividad)
    const sinPaso = await executeKw("crm.lead","search_read",
      [[dominio, ["type","=","opportunity"], ["active","=",true], ["activity_ids","=",false]]],
      { fields:["id","name","partner_name","contact_name","partner_id","stage_id","expected_revenue"], limit:20 }).catch(()=>[]);
    plan.sinPaso = sinPaso.length;
    plan.sinPasoLista = sinPaso.map(l=>({
      leadId:l.id, oportunidad:l.name||"Oportunidad",
      etapa:m2oName(l.stage_id)||"",
      cliente:(l.partner_name||m2oName(l.partner_id)||l.contact_name||"—")+(l.stage_id?(" · "+m2oName(l.stage_id)):""),
      monto:mxn(l.expected_revenue),
    }));

    // Oportunidades en etapa "Nuevo": recién capturadas, por calificar tras la visita.
    const porCal = await executeKw("crm.lead","search_read",
      [[dominio, ["type","=","opportunity"], ["active","=",true], ["stage_id.name","=","Nuevo"]]],
      { fields:["id","name","partner_name","contact_name","partner_id","stage_id","expected_revenue"], limit:20 }).catch(()=>[]);
    plan.porCalificar = porCal.map(l=>({
      leadId:l.id, oportunidad:l.name||"Oportunidad",
      etapa:m2oName(l.stage_id)||"Nuevo",
      cliente:(l.partner_name||m2oName(l.partner_id)||l.contact_name||"—")+" · "+(m2oName(l.stage_id)||"Nuevo"),
      monto:mxn(l.expected_revenue),
    }));

    // TODOS los leads/oportunidades abiertos del vendedor (cualquier etapa, menos Ganado):
    // cada uno trae su siguiente paso (si tiene) y si requiere atención.
    const actsByLead = {};
    acts.forEach(a=>{ (actsByLead[a.res_id]=actsByLead[a.res_id]||[]).push(a); });
    plan.items = leads
      .filter(l => l.type === "opportunity" && m2oName(l.stage_id) !== "Ganado")
      .map(l => {
        const la = (actsByLead[l.id]||[]).slice()
          .sort((x,y)=>String(x.date_deadline||"").localeCompare(String(y.date_deadline||"")));
        let sig = null, estado = "none";
        if (la.length){
          const a = la[0], dd = a.date_deadline || "";
          estado = dd < today ? "due" : (dd === today ? "today" : "ok");
          const tt = tipoById[Array.isArray(a.activity_type_id)?a.activity_type_id[0]:0] || {};
          sig = { resumen: a.summary || tt.name || "Siguiente paso",
                  fecha: (estado==="due"?"Vencida · ":"") + fechaCorta(dd), estado };
        }
        return {
          leadId: l.id,
          nombre: l.name || "—",
          cliente: (l.partner_name || m2oName(l.partner_id) || l.contact_name || "—"),
          etapa: m2oName(l.stage_id) || "—",
          monto: mxn(l.expected_revenue),
          sig,
          atencion: (estado === "due" || estado === "none"),  // vencida o sin siguiente paso
        };
      });

    return json({ ok:true, plan });
  }catch(e){ return json({ ok:false, error:String(e.message||e) },500); }
};

function fechaCorta(s){ if(!s) return "—"; const d=new Date(s); if(isNaN(d)) return "—"; return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`; }
