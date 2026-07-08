// mangueras.app.js — Catálogo de áreas y equipos por cliente.
// AQUÍ el administrador da de alta las áreas y equipos de cada cliente.
// Son los datos que el técnico verá filtrados en el COTIZADOR:
// elige cliente → aparecen solo sus áreas → elige área → solo sus equipos.
// Se guarda en Odoo como adjunto del cliente (portal_mangueras.json).
import React, { useState, useEffect, useMemo } from "react";
import htm from "htm";

const html = htm.bind(React.createElement);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMPTY_DOC = () => ({ rev: 0, areas: [] });
const selCls = "w-full rounded border border-slate-300 bg-white px-1.5 py-1.5 text-[13px] text-slate-800 focus:border-blue-500 focus:outline-none";

export default function App() {
  const [clientes, setClientes] = useState([]);
  const [clienteId, setClienteId] = useState("");
  const [doc, setDoc] = useState(EMPTY_DOC());
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch("/api/odoo-clientes").then((r) => r.json()).then((d) => {
      if (d.ok && Array.isArray(d.clientes)) setClientes(d.clientes);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const load = async (pid) => {
    setClienteId(pid); setMsg(null);
    if (!pid) { setDoc(EMPTY_DOC()); setDirty(false); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/mangueras-listar?partnerId=" + pid);
      const d = await r.json();
      if (d.ok) { setDoc(d.doc || EMPTY_DOC()); setDirty(false); }
      else setMsg({ err: d.error || "No pude cargar el catálogo." });
    } catch (e) { setMsg({ err: String(e.message || e) }); }
    finally { setLoading(false); }
  };

  const save = async () => {
    if (!clienteId) return;
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/mangueras-guardar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId: Number(clienteId), rev: doc.rev || 0, doc }),
      });
      const d = await r.json();
      if (d.ok) { setDoc({ ...doc, rev: d.rev }); setDirty(false); setMsg({ ok: "Catálogo guardado. El técnico ya lo verá en el cotizador." }); }
      else if (d.conflict) setMsg({ err: d.error });
      else setMsg({ err: d.error || "No se pudo guardar." });
    } catch (e) { setMsg({ err: String(e.message || e) }); }
    finally { setSaving(false); }
  };

  const mut = (fn) => { setDoc((d) => { const nd = structuredClone(d); fn(nd); return nd; }); setDirty(true); };

  const addArea = () => {
    const n = (window.prompt("Nombre del área o planta (p. ej. Planta Apodaca, Molienda, Línea 2):") || "").trim();
    if (!n) return;
    mut((d) => d.areas.push({ id: uid(), nombre: n, equipos: [] }));
  };
  const renArea = (a) => {
    const n = (window.prompt("Nuevo nombre del área:", a.nombre) || "").trim();
    if (!n) return;
    mut((d) => { d.areas.find((x) => x.id === a.id).nombre = n; });
  };
  const delArea = (a) => {
    const nM = (a.equipos || []).reduce((s, e) => s + (e.mangueras || []).length, 0);
    if (!window.confirm(`¿Eliminar el área "${a.nombre}" con sus ${a.equipos.length} equipo(s)${nM ? ` y ${nM} manguera(s) del plan` : ""}?`)) return;
    mut((d) => { d.areas = d.areas.filter((x) => x.id !== a.id); });
  };
  const addEquipo = (a) => {
    const n = (window.prompt(`Nombre del equipo para "${a.nombre}" (p. ej. Prensa hidráulica 2, Retro CAT 420):`) || "").trim();
    if (!n) return;
    mut((d) => d.areas.find((x) => x.id === a.id).equipos.push({ id: uid(), nombre: n, mangueras: [] }));
  };
  const renEquipo = (a, e) => {
    const n = (window.prompt("Nuevo nombre del equipo:", e.nombre) || "").trim();
    if (!n) return;
    mut((d) => { d.areas.find((x) => x.id === a.id).equipos.find((y) => y.id === e.id).nombre = n; });
  };
  const delEquipo = (a, e) => {
    const nM = (e.mangueras || []).length;
    if (!window.confirm(`¿Eliminar el equipo "${e.nombre}"${nM ? ` y sus ${nM} manguera(s) del plan` : ""}?`)) return;
    mut((d) => {
      const ar = d.areas.find((x) => x.id === a.id);
      ar.equipos = ar.equipos.filter((y) => y.id !== e.id);
    });
  };

  const totales = useMemo(() => {
    let eq = 0; for (const a of doc.areas) eq += a.equipos.length;
    return { areas: doc.areas.length, eq };
  }, [doc]);

  return html`
    <div className="mx-auto max-w-[980px] p-4" style=${{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif" }}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Cliente</label>
          <select className=${selCls + " min-w-[280px]"} value=${clienteId} onChange=${(e) => {
            if (dirty && !window.confirm("Tienes cambios sin guardar. ¿Cambiar de cliente y perderlos?")) return;
            load(e.target.value);
          }}>
            <option value="">— Elige un cliente —</option>
            ${clientes.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
          </select>
        </div>
        <div className="flex items-center gap-3">
          ${clienteId && html`<span className="text-[12px] text-slate-500">${totales.areas} áreas · ${totales.eq} equipos</span>`}
          ${clienteId && html`
            <button disabled=${!dirty || saving}
              className=${"rounded px-4 py-2 text-[13px] font-bold text-white " + (dirty ? "bg-emerald-600 hover:bg-emerald-700" : "bg-slate-300")}
              onClick=${save}>${saving ? "Guardando…" : dirty ? "Guardar cambios" : "Todo guardado"}</button>`}
        </div>
      </div>

      ${msg && html`<div className=${"mb-3 rounded-lg px-3 py-2 text-[13px] " + (msg.err ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700")}>${msg.err || msg.ok}</div>`}

      ${!clienteId && html`
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-400">
          Elige un cliente para dar de alta sus áreas y equipos.<br/>
          <span className="text-[12px]">Estos datos son los que el técnico verá filtrados en el cotizador de mangueras.</span>
        </div>`}

      ${clienteId && loading && html`<div className="p-4 text-[13px] text-slate-400">Cargando catálogo…</div>`}

      ${clienteId && !loading && html`
        <div>
          <div className="mb-3 flex justify-end">
            <button className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-blue-700" onClick=${addArea}>+ Agregar área</button>
          </div>
          ${doc.areas.length === 0 && html`
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-[13px] text-slate-400">
              Este cliente aún no tiene áreas. Agrega la primera (planta, nave, línea, zona…).
            </div>`}
          ${doc.areas.map((a) => html`
            <div key=${a.id} className="mb-3 rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-bold text-slate-800">${a.nombre}
                  <span className="ml-2 text-[12px] font-normal text-slate-400">${a.equipos.length} equipo(s)</span>
                </div>
                <div className="flex gap-1.5">
                  <button className="rounded bg-slate-800 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-slate-700" onClick=${() => addEquipo(a)}>+ Equipo</button>
                  <button className="rounded border border-slate-300 px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-50" onClick=${() => renArea(a)}>Renombrar</button>
                  <button className="rounded border border-rose-200 px-2.5 py-1 text-[11px] text-rose-500 hover:bg-rose-50" onClick=${() => delArea(a)}>Eliminar</button>
                </div>
              </div>
              ${a.equipos.length === 0
                ? html`<div className="rounded border border-dashed border-slate-200 px-3 py-2 text-[12px] text-slate-400">Sin equipos. Agrega los equipos de esta área.</div>`
                : a.equipos.map((e) => html`
                  <div key=${e.id} className="flex items-center justify-between gap-2 border-t border-slate-100 py-1.5 pl-2">
                    <span className="text-[13px] text-slate-700">${e.nombre}
                      ${(e.mangueras || []).length > 0 && html`<span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">${e.mangueras.length} manguera(s) en plan</span>`}
                    </span>
                    <span className="flex gap-1.5">
                      <button className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50" onClick=${() => renEquipo(a, e)}>Renombrar</button>
                      <button className="rounded border border-rose-200 px-2 py-0.5 text-[11px] text-rose-500 hover:bg-rose-50" onClick=${() => delEquipo(a, e)}>Eliminar</button>
                    </span>
                  </div>`)}
            </div>`)}
        </div>`}
    </div>`;
}
