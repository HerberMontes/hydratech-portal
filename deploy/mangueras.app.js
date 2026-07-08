// mangueras.app.js — Censo de mangueras instaladas (Cliente → Área → Equipo → Manguera)
// Reutiliza el catálogo del configurador (extremos A/B) y guarda el censo en Odoo
// como adjunto JSON del cliente (portal_mangueras.json) vía /api/mangueras-*.
import React, { useState, useEffect, useMemo, useRef } from "react";
import htm from "htm";
import {
  DASH, FAM_LABEL, famsAll, estFor, medFor, angFor, validSide, quoteLine
} from "./configurador.app.js";

const html = htm.bind(React.createElement);

/* ============================== Utilidades ============================== */

const ALFA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I/L para etiquetas legibles
function genId() {
  let s = "";
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  for (let i = 0; i < 6; i++) s += ALFA[a[i] % ALFA.length];
  return "HT-" + s;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const hoy = () => new Date().toISOString().slice(0, 10);
const norm360 = (a) => ((Math.round(a) % 360) + 360) % 360;
const money = (n) => "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function userEmail() {
  try { return window.netlifyIdentity?.currentUser()?.email || ""; } catch { return ""; }
}

// Texto humano de un extremo a partir de los catálogos del configurador.
function sideLabel(side) {
  const est = estFor(side.g).find((e) => e.sk === side.sk);
  const med = medFor(side.g, side.sk).find((m) => m.th === side.th);
  const ang = angFor(side.g, side.sk, side.th).find((a) => a[0] === side.ak);
  const parts = [FAM_LABEL[side.g] || side.g, est?.sl || side.sk, med?.ml || side.th];
  if (side.ak !== "R") parts.push(ang ? ang[1] : side.ak);
  return parts.join(" ");
}
const hasCodo = (side) => side.ak !== "R";

function orientTxt(m) {
  const p = [];
  if (hasCodo(m.A)) p.push(`A ${norm360(m.A.or || 0)}°`);
  if (hasCodo(m.B)) p.push(`B ${norm360(m.B.or || 0)}°`);
  if (hasCodo(m.A) && hasCodo(m.B)) p.push(`desfase ${norm360((m.B.or || 0) - (m.A.or || 0))}°`);
  return p.length ? p.join(" · ") + " (ref. curva)" : "—";
}

// Descripción completa para cotizaciones / fabricación.
function specTxt(m) {
  let t = `Manguera ⌀${DASH[m.A.th] || m.A.th}" · ${m.len} m · ${m.pres} psi — A: ${sideLabel(m.A)} | B: ${sideLabel(m.B)}`;
  const o = orientTxt(m);
  if (o !== "—") t += ` — Orientación: ${o}`;
  return t;
}

function qrUrl(clienteId, mangId) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `${base}manguera.html?c=${clienteId}&m=${encodeURIComponent(mangId)}`;
}

const EMPTY_DOC = () => ({ rev: 0, areas: [] });
const defSide = () => validSide({ g: "M", sk: "npt", th: "08", ak: "R" });
const newHose = () => ({
  id: genId(), pres: 3000, len: 1, A: { ...defSide(), or: 0 }, B: { ...defSide(), or: 0 },
  notas: "", alta: hoy(), tec: userEmail(), estado: "activa",
});

/* ===================== Selector visual de orientación ===================== */
// Convención: mirando la manguera de frente por ese extremo, 0° = el codo apunta
// hacia el interior de la curva natural del rollo; los grados corren en sentido
// horario. Se captura en pasos de 15°.

function OrientDial({ value = 0, onChange, label }) {
  const S = 148, C = S / 2, R = 62;
  const a = norm360(value);
  const drag = useRef(false);

  const setFrom = (clientX, clientY, el) => {
    const r = el.getBoundingClientRect();
    const x = clientX - r.left - r.width / 2;
    const y = clientY - r.top - r.height / 2;
    let ang = Math.atan2(x, -y) * 180 / Math.PI; // 0° arriba, horario
    onChange(norm360(Math.round(ang / 15) * 15));
  };
  const onDown = (e) => { drag.current = true; const p = e.touches ? e.touches[0] : e; setFrom(p.clientX, p.clientY, e.currentTarget); };
  const onMove = (e) => { if (!drag.current) return; const p = e.touches ? e.touches[0] : e; setFrom(p.clientX, p.clientY, e.currentTarget); if (e.touches) e.preventDefault(); };
  const onUp = () => { drag.current = false; };

  const ticks = [];
  for (let t = 0; t < 360; t += 15) {
    const big = t % 90 === 0;
    const r1 = R - (big ? 10 : 5), r2 = R;
    const rad = t * Math.PI / 180;
    ticks.push(html`<line key=${t}
      x1=${C + r1 * Math.sin(rad)} y1=${C - r1 * Math.cos(rad)}
      x2=${C + r2 * Math.sin(rad)} y2=${C - r2 * Math.cos(rad)}
      stroke=${big ? "#475569" : "#cbd5e1"} strokeWidth=${big ? 2 : 1} />`);
  }
  const rad = a * Math.PI / 180;
  const hx = C + (R - 18) * Math.sin(rad), hy = C - (R - 18) * Math.cos(rad);

  return html`
    <div className="flex flex-col items-center gap-1 select-none">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">${label}</div>
      <svg width=${S} height=${S} viewBox=${"0 0 " + S + " " + S}
        style=${{ touchAction: "none", cursor: "pointer" }}
        onMouseDown=${onDown} onMouseMove=${onMove} onMouseUp=${onUp} onMouseLeave=${onUp}
        onTouchStart=${onDown} onTouchMove=${onMove} onTouchEnd=${onUp}>
        <circle cx=${C} cy=${C} r=${R} fill="#fff" stroke="#e2e8f0" strokeWidth="2" />
        ${ticks}
        ${/* Referencia de la curva natural: banda ámbar arriba (0°) */""}
        <path d=${`M ${C + (R + 7) * Math.sin(-0.42)} ${C - (R + 7) * Math.cos(-0.42)}
                   A ${R + 7} ${R + 7} 0 0 1 ${C + (R + 7) * Math.sin(0.42)} ${C - (R + 7) * Math.cos(0.42)}`}
          fill="none" stroke="#f59e0b" strokeWidth="5" strokeLinecap="round" />
        <text x=${C} y="11" textAnchor="middle" fontSize="9" fontWeight="700" fill="#b45309">CURVA</text>
        <text x=${C} y=${C - R + 22} textAnchor="middle" fontSize="9" fill="#94a3b8">0°</text>
        <text x=${C + R - 22} y=${C + 3} textAnchor="middle" fontSize="9" fill="#94a3b8">90°</text>
        <text x=${C} y=${C + R - 14} textAnchor="middle" fontSize="9" fill="#94a3b8">180°</text>
        <text x=${C - R + 22} y=${C + 3} textAnchor="middle" fontSize="9" fill="#94a3b8">270°</text>
        ${/* Cuerpo de la manguera (cruz al centro) y codo (flecha) */""}
        <circle cx=${C} cy=${C} r="13" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="2" />
        <line x1=${C} y1=${C} x2=${hx} y2=${hy} stroke="#2563eb" strokeWidth="5" strokeLinecap="round" />
        <circle cx=${hx} cy=${hy} r="7" fill="#2563eb" />
        <text x=${C} y=${C + 4} textAnchor="middle" fontSize="9" fontWeight="700" fill="#475569">⌀</text>
      </svg>
      <div className="flex items-center gap-1">
        <button type="button" className="rounded border border-slate-300 bg-white px-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50"
          onClick=${() => onChange(norm360(a - 15))}>−15°</button>
        <span className="w-12 text-center font-mono text-[15px] font-bold text-blue-700">${a}°</span>
        <button type="button" className="rounded border border-slate-300 bg-white px-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50"
          onClick=${() => onChange(norm360(a + 15))}>+15°</button>
      </div>
    </div>`;
}

/* ======================= Editor de un extremo (A/B) ======================= */

const selCls = "w-full rounded border border-slate-300 bg-white px-1.5 py-1.5 text-[13px] text-slate-800 focus:border-blue-500 focus:outline-none";

function SideEditor({ label, side, onChange }) {
  const fams = useMemo(() => famsAll(), []);
  const ests = useMemo(() => estFor(side.g), [side.g]);
  const meds = useMemo(() => medFor(side.g, side.sk), [side.g, side.sk]);
  const angs = useMemo(() => angFor(side.g, side.sk, side.th), [side.g, side.sk, side.th]);
  const upd = (patch) => onChange({ ...validSide({ ...side, ...patch }), or: side.or || 0 });

  return html`
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-slate-600">Extremo ${label}</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-slate-500">Familia
          <select className=${selCls} value=${side.g} onChange=${(e) => upd({ g: e.target.value })}>
            ${fams.map((f) => html`<option key=${f.g} value=${f.g}>${f.label}</option>`)}
          </select>
        </label>
        <label className="text-[11px] text-slate-500">Estilo / rosca
          <select className=${selCls} value=${side.sk} onChange=${(e) => upd({ sk: e.target.value })}>
            ${ests.map((e2) => html`<option key=${e2.sk} value=${e2.sk}>${e2.sl}</option>`)}
          </select>
        </label>
        <label className="text-[11px] text-slate-500">Medida
          <select className=${selCls} value=${side.th} onChange=${(e) => upd({ th: e.target.value })}>
            ${meds.map((m) => html`<option key=${m.th} value=${m.th}>${m.ml}</option>`)}
          </select>
        </label>
        <label className="text-[11px] text-slate-500">Ángulo
          <select className=${selCls} value=${side.ak} onChange=${(e) => onChange({ ...side, ak: e.target.value, or: side.or || 0 })}>
            ${angs.map((a) => html`<option key=${a[0]} value=${a[0]}>${a[1]}</option>`)}
          </select>
        </label>
      </div>
      ${hasCodo(side) && html`
        <div className="mt-3 flex justify-center">
          <${OrientDial} label=${"Orientación del codo " + label}
            value=${side.or || 0} onChange=${(or) => onChange({ ...side, or })} />
        </div>`}
    </div>`;
}

/* ========================= Formulario de manguera ========================= */

function HoseForm({ initial, onSave, onCancel }) {
  const [m, setM] = useState(initial);
  const q = useMemo(() => quoteLine({ pres: m.pres, len: m.len, A: m.A, B: m.B }), [m]);
  const desfase = hasCodo(m.A) && hasCodo(m.B) ? norm360((m.B.or || 0) - (m.A.or || 0)) : null;

  return html`
    <div className="rounded-xl border border-blue-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-bold text-slate-800">
          ${initial._nueva ? "Nueva manguera" : "Editar manguera"}
          <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 font-mono text-[12px] text-slate-600">${m.id}</span>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-[11px] text-slate-500">Presión de trabajo (PSI)
          <input type="number" min="0" className=${selCls} value=${m.pres}
            onChange=${(e) => setM({ ...m, pres: e.target.value })} />
        </label>
        <label className="text-[11px] text-slate-500">Largo total (m)
          <input type="number" min="0" step="0.01" className=${selCls} value=${m.len}
            onChange=${(e) => setM({ ...m, len: e.target.value })} />
        </label>
        <label className="col-span-2 text-[11px] text-slate-500">Notas (ubicación exacta, observaciones)
          <input type="text" className=${selCls} value=${m.notas}
            onChange=${(e) => setM({ ...m, notas: e.target.value })} placeholder="p. ej. lado motor, pasa por guarda" />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <${SideEditor} label="A" side=${m.A} onChange=${(A) => setM({ ...m, A })} />
        <${SideEditor} label="B" side=${m.B} onChange=${(B) => setM({ ...m, B })} />
      </div>

      ${(hasCodo(m.A) || hasCodo(m.B)) && html`
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <b>Orientación</b> · 0° = el codo apunta hacia el interior de la curva natural del rollo; grados en sentido
          horario mirando la manguera de frente por ese extremo.
          ${desfase !== null && html` <b className="ml-1">Desfase A→B: ${desfase}°.</b>`}
        </div>`}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-slate-500">
          ${q.error
            ? html`<span className="text-rose-600">${q.error}</span>`
            : html`Precio lista estimado: <b className="text-slate-800">${money(q.customer)}</b>
                   <span className="ml-1 text-slate-400">(${q.hose.name}, ${q.sys})</span>`}
        </div>
        <div className="flex gap-2">
          <button className="rounded border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50"
            onClick=${onCancel}>Cancelar</button>
          <button className="rounded bg-blue-600 px-4 py-1.5 text-[12px] font-bold text-white hover:bg-blue-700"
            onClick=${() => {
              const clean = { ...m, pres: +m.pres || 0, len: +m.len || 0 };
              delete clean._nueva;
              onSave(clean);
            }}>Guardar manguera</button>
        </div>
      </div>
    </div>`;
}

/* ============================ Modal QR ============================ */

function QRModal({ hose, clienteId, clienteNombre, ubic, onClose, onPrint }) {
  const boxRef = useRef(null);
  useEffect(() => {
    if (boxRef.current && window.QRCode) {
      boxRef.current.innerHTML = "";
      new window.QRCode(boxRef.current, { text: qrUrl(clienteId, hose.id), width: 180, height: 180, correctLevel: window.QRCode.CorrectLevel.M });
    }
  }, [hose, clienteId]);
  return html`
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" onClick=${onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 text-center shadow-xl" onClick=${(e) => e.stopPropagation()}>
        <div className="font-mono text-lg font-bold text-slate-800">${hose.id}</div>
        <div className="mt-1 text-[12px] text-slate-500">${clienteNombre} · ${ubic}</div>
        <div ref=${boxRef} className="my-4 flex justify-center"></div>
        <div className="text-[12px] text-slate-600">${specTxt(hose)}</div>
        <div className="mt-4 flex justify-center gap-2">
          <button className="rounded border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50" onClick=${onClose}>Cerrar</button>
          <button className="rounded bg-slate-800 px-4 py-1.5 text-[12px] font-bold text-white hover:bg-slate-700" onClick=${onPrint}>Imprimir etiqueta</button>
        </div>
      </div>
    </div>`;
}

/* =========================== Impresión de etiquetas =========================== */

function printLabels(hoses, clienteId, clienteNombre, ubicOf) {
  const root = document.getElementById("print-labels");
  if (!root || !window.QRCode) { alert("No se pudo preparar la impresión de etiquetas."); return; }
  root.innerHTML = "";
  const grid = document.createElement("div");
  grid.style.cssText = "display:flex;flex-wrap:wrap;gap:6mm;padding:8mm;font-family:'IBM Plex Sans',sans-serif;";
  for (const h of hoses) {
    const card = document.createElement("div");
    card.style.cssText = "width:70mm;border:1px solid #000;border-radius:2mm;padding:3mm;display:flex;gap:3mm;align-items:center;break-inside:avoid;";
    const qrBox = document.createElement("div");
    new window.QRCode(qrBox, { text: qrUrl(clienteId, h.id), width: 84, height: 84, correctLevel: window.QRCode.CorrectLevel.M });
    const info = document.createElement("div");
    info.style.cssText = "font-size:8pt;line-height:1.25;";
    info.innerHTML =
      `<div style="font-family:monospace;font-size:12pt;font-weight:800;">${h.id}</div>` +
      `<div>${clienteNombre}</div>` +
      `<div>${ubicOf(h)}</div>` +
      `<div>⌀${DASH[h.A.th] || ""}&quot; · ${h.len} m · ${h.pres} psi</div>` +
      `<div style="font-size:7pt;color:#333;">Escanea para pedir reemplazo</div>`;
    card.appendChild(qrBox); card.appendChild(info); grid.appendChild(card);
  }
  root.appendChild(grid);
  setTimeout(() => { window.print(); }, 350);
}

/* ================================ App ================================ */

export default function App() {
  const [clientes, setClientes] = useState([]);
  const [clienteId, setClienteId] = useState("");
  const [doc, setDoc] = useState(EMPTY_DOC());
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [selArea, setSelArea] = useState("");
  const [selEquipo, setSelEquipo] = useState("");
  const [editing, setEditing] = useState(null); // manguera en edición
  const [qrHose, setQrHose] = useState(null);

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

  const clienteNombre = useMemo(
    () => clientes.find((c) => String(c.id) === String(clienteId))?.name || "",
    [clientes, clienteId]);

  const load = async (pid) => {
    setClienteId(pid); setSelArea(""); setSelEquipo(""); setEditing(null); setMsg(null);
    if (!pid) { setDoc(EMPTY_DOC()); setDirty(false); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/mangueras-listar?partnerId=" + pid);
      const d = await r.json();
      if (d.ok) { setDoc(d.doc || EMPTY_DOC()); setDirty(false); }
      else setMsg({ err: d.error || "No pude cargar el censo." });
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
      if (d.ok) { setDoc({ ...doc, rev: d.rev }); setDirty(false); setMsg({ ok: "Censo guardado en Odoo." }); }
      else if (d.conflict) setMsg({ err: d.error + " (usa Recargar)" });
      else setMsg({ err: d.error || "No se pudo guardar." });
    } catch (e) { setMsg({ err: String(e.message || e) }); }
    finally { setSaving(false); }
  };

  const mut = (fn) => { setDoc((d) => { const nd = structuredClone(d); fn(nd); return nd; }); setDirty(true); };

  const area = doc.areas.find((a) => a.id === selArea);
  const equipo = area?.equipos.find((e) => e.id === selEquipo);

  const addArea = () => {
    const n = (window.prompt("Nombre del área (p. ej. Molienda, Patio, Línea 2):") || "").trim();
    if (!n) return;
    const id = uid();
    mut((d) => d.areas.push({ id, nombre: n, equipos: [] }));
    setSelArea(id); setSelEquipo("");
  };
  const addEquipo = () => {
    if (!area) return;
    const n = (window.prompt("Nombre del equipo (p. ej. Prensa hidráulica 2, Retroexcavadora CAT 420):") || "").trim();
    if (!n) return;
    const id = uid();
    mut((d) => d.areas.find((a) => a.id === selArea).equipos.push({ id, nombre: n, mangueras: [] }));
    setSelEquipo(id);
  };
  const rename = (tipo) => {
    const cur = tipo === "area" ? area : equipo;
    const n = (window.prompt("Nuevo nombre:", cur.nombre) || "").trim();
    if (!n) return;
    mut((d) => {
      const a = d.areas.find((x) => x.id === selArea);
      if (tipo === "area") a.nombre = n;
      else a.equipos.find((x) => x.id === selEquipo).nombre = n;
    });
  };
  const remove = (tipo) => {
    const cur = tipo === "area" ? area : equipo;
    const nHoses = tipo === "area"
      ? cur.equipos.reduce((s, e) => s + e.mangueras.length, 0)
      : cur.mangueras.length;
    if (!window.confirm(`¿Eliminar "${cur.nombre}"${nHoses ? ` y sus ${nHoses} manguera(s)` : ""}? Esta acción no se puede deshacer.`)) return;
    mut((d) => {
      const a = d.areas.find((x) => x.id === selArea);
      if (tipo === "area") d.areas = d.areas.filter((x) => x.id !== selArea);
      else a.equipos = a.equipos.filter((x) => x.id !== selEquipo);
    });
    if (tipo === "area") { setSelArea(""); setSelEquipo(""); } else setSelEquipo("");
  };

  const saveHose = (m) => {
    mut((d) => {
      const eq = d.areas.find((a) => a.id === selArea).equipos.find((e) => e.id === selEquipo);
      const i = eq.mangueras.findIndex((x) => x.id === m.id);
      if (i >= 0) eq.mangueras[i] = m; else eq.mangueras.push(m);
    });
    setEditing(null);
  };
  const dupHose = (m) => {
    const c = structuredClone(m); c.id = genId(); c.alta = hoy(); c.tec = userEmail();
    mut((d) => {
      const eq = d.areas.find((a) => a.id === selArea).equipos.find((e) => e.id === selEquipo);
      eq.mangueras.push(c);
    });
  };
  const delHose = (m) => {
    if (!window.confirm(`¿Eliminar la manguera ${m.id} del censo?`)) return;
    mut((d) => {
      const eq = d.areas.find((a) => a.id === selArea).equipos.find((e) => e.id === selEquipo);
      eq.mangueras = eq.mangueras.filter((x) => x.id !== m.id);
    });
  };

  const ubicOf = (h) => {
    for (const a of doc.areas) for (const e of a.equipos)
      if (e.mangueras.some((x) => x.id === h.id)) return `${a.nombre} · ${e.nombre}`;
    return "";
  };

  const totales = useMemo(() => {
    let eq = 0, mg = 0;
    for (const a of doc.areas) { eq += a.equipos.length; for (const e of a.equipos) mg += e.mangueras.length; }
    return { areas: doc.areas.length, eq, mg };
  }, [doc]);

  return html`
    <div className="mx-auto max-w-[1560px] p-4" style=${{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif" }}>

      ${/* Encabezado: cliente + guardar */""}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Cliente</label>
          <div className="flex items-center gap-2">
            <select className=${selCls + " min-w-[260px]"} value=${clienteId} onChange=${(e) => {
              if (dirty && !window.confirm("Tienes cambios sin guardar. ¿Cambiar de cliente y perderlos?")) return;
              load(e.target.value);
            }}>
              <option value="">— Elige un cliente —</option>
              ${clientes.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
            </select>
            ${clienteId && html`<button className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50"
              onClick=${() => load(clienteId)}>Recargar</button>`}
          </div>
        </div>
        <div className="flex items-center gap-3">
          ${clienteId && html`<span className="text-[12px] text-slate-500">${totales.areas} áreas · ${totales.eq} equipos · <b>${totales.mg} mangueras</b></span>`}
          ${clienteId && html`
            <button disabled=${!dirty || saving}
              className=${"rounded px-4 py-2 text-[13px] font-bold text-white " + (dirty ? "bg-emerald-600 hover:bg-emerald-700" : "bg-slate-300")}
              onClick=${save}>${saving ? "Guardando…" : dirty ? "Guardar cambios" : "Todo guardado"}</button>`}
        </div>
      </div>

      ${msg && html`<div className=${"mb-3 rounded-lg px-3 py-2 text-[13px] " + (msg.err ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700")}>${msg.err || msg.ok}</div>`}

      ${!clienteId && html`
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-400">
          Elige un cliente para levantar o consultar su censo de mangueras.<br/>
          <span className="text-[12px]">Cliente → Área → Equipo → Manguera, cada una con su código QR.</span>
        </div>`}

      ${clienteId && html`
      <div className="grid gap-4 lg:grid-cols-[290px_1fr]">

        ${/* Árbol de áreas y equipos */""}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-bold uppercase tracking-wide text-slate-500">Áreas y equipos</span>
            <button className="rounded bg-slate-800 px-2 py-1 text-[11px] font-bold text-white hover:bg-slate-700" onClick=${addArea}>+ Área</button>
          </div>
          ${loading && html`<div className="p-3 text-[13px] text-slate-400">Cargando censo…</div>`}
          ${!loading && doc.areas.length === 0 && html`<div className="p-3 text-[13px] text-slate-400">Aún no hay áreas. Crea la primera para empezar el levantamiento.</div>`}
          ${doc.areas.map((a) => html`
            <div key=${a.id} className="mb-1">
              <button className=${"w-full rounded px-2 py-1.5 text-left text-[13px] font-bold " + (selArea === a.id ? "bg-blue-50 text-blue-800" : "text-slate-700 hover:bg-slate-50")}
                onClick=${() => { setSelArea(a.id); setSelEquipo(""); setEditing(null); }}>
                ${a.nombre} <span className="font-normal text-slate-400">(${a.equipos.length})</span>
              </button>
              ${selArea === a.id && html`
                <div className="ml-3 border-l border-slate-200 pl-2">
                  ${a.equipos.map((e) => html`
                    <button key=${e.id}
                      className=${"block w-full rounded px-2 py-1 text-left text-[13px] " + (selEquipo === e.id ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50")}
                      onClick=${() => { setSelEquipo(e.id); setEditing(null); }}>
                      ${e.nombre} <span className=${selEquipo === e.id ? "text-blue-200" : "text-slate-400"}>(${e.mangueras.length})</span>
                    </button>`)}
                  <div className="mt-1 flex gap-1">
                    <button className="rounded border border-slate-300 px-2 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50" onClick=${addEquipo}>+ Equipo</button>
                    <button className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50" onClick=${() => rename("area")}>Renombrar</button>
                    <button className="rounded border border-rose-200 px-2 py-0.5 text-[11px] text-rose-500 hover:bg-rose-50" onClick=${() => remove("area")}>Eliminar</button>
                  </div>
                </div>`}
            </div>`)}
        </div>

        ${/* Panel principal: mangueras del equipo */""}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          ${!equipo && html`<div className="p-8 text-center text-[13px] text-slate-400">Elige (o crea) un área y un equipo para registrar sus mangueras.</div>`}
          ${equipo && html`
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-bold text-slate-800">${area.nombre} · ${equipo.nombre}</div>
                  <div className="text-[12px] text-slate-400">${equipo.mangueras.length} manguera(s) censada(s)</div>
                </div>
                <div className="flex gap-2">
                  <button className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50" onClick=${() => rename("equipo")}>Renombrar</button>
                  <button className="rounded border border-rose-200 bg-white px-2.5 py-1.5 text-[12px] text-rose-500 hover:bg-rose-50" onClick=${() => remove("equipo")}>Eliminar equipo</button>
                  ${equipo.mangueras.length > 0 && html`
                    <button className="rounded bg-slate-800 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-slate-700"
                      onClick=${() => printLabels(equipo.mangueras, clienteId, clienteNombre, ubicOf)}>Imprimir etiquetas QR</button>`}
                  <button className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-blue-700"
                    onClick=${() => setEditing({ ...newHose(), _nueva: true })}>+ Registrar manguera</button>
                </div>
              </div>

              ${editing && html`<div className="mb-4"><${HoseForm} initial=${editing} onSave=${saveHose} onCancel=${() => setEditing(null)} /></div>`}

              ${equipo.mangueras.length === 0 && !editing && html`
                <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-[13px] text-slate-400">
                  Este equipo aún no tiene mangueras registradas. Usa “Registrar manguera”.
                </div>`}

              ${equipo.mangueras.length > 0 && html`
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]" style=${{ minWidth: 860 }}>
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="px-2 py-1.5">ID</th>
                        <th className="px-2 py-1.5">Ø / PSI / Largo</th>
                        <th className="px-2 py-1.5">Extremo A</th>
                        <th className="px-2 py-1.5">Extremo B</th>
                        <th className="px-2 py-1.5">Orientación</th>
                        <th className="px-2 py-1.5">Alta</th>
                        <th className="px-2 py-1.5"></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${equipo.mangueras.map((h) => html`
                        <tr key=${h.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                          <td className="px-2 py-2 font-mono font-bold text-slate-700">${h.id}</td>
                          <td className="px-2 py-2 text-slate-700">⌀${DASH[h.A.th] || h.A.th}" · ${h.pres} psi · ${h.len} m</td>
                          <td className="px-2 py-2 text-slate-600">${sideLabel(h.A)}</td>
                          <td className="px-2 py-2 text-slate-600">${sideLabel(h.B)}</td>
                          <td className="px-2 py-2 text-slate-600">${orientTxt(h)}</td>
                          <td className="px-2 py-2 text-slate-400">${h.alta || ""}</td>
                          <td className="px-2 py-2">
                            <div className="flex justify-end gap-1">
                              <button title="Ver QR" className="rounded border border-slate-300 px-2 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-white" onClick=${() => setQrHose(h)}>QR</button>
                              <button className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-white" onClick=${() => setEditing(structuredClone(h))}>Editar</button>
                              <button className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-white" onClick=${() => dupHose(h)}>Duplicar</button>
                              <button className="rounded border border-rose-200 px-2 py-0.5 text-[11px] text-rose-500 hover:bg-rose-50" onClick=${() => delHose(h)}>Eliminar</button>
                            </div>
                          </td>
                        </tr>`)}
                    </tbody>
                  </table>
                </div>`}
            </div>`}
        </div>
      </div>`}

      ${qrHose && html`<${QRModal} hose=${qrHose} clienteId=${clienteId} clienteNombre=${clienteNombre}
        ubic=${ubicOf(qrHose)} onClose=${() => setQrHose(null)}
        onPrint=${() => printLabels([qrHose], clienteId, clienteNombre, ubicOf)} />`}
    </div>`;
}
