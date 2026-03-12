import { useState, useEffect, useRef, useCallback } from "react";

// ──────────────────────────────────────────────────────────────────────
// ─── CPM / PERT Engine ────────────────────────────────────────────────────────

function computePERT(o, m, p) { return (o + 4 * m + p) / 6; }
function computeSigma(o, p) { return (p - o) / 6; }

function topoSort(nodes) {
  const visited = new Set(), result = [];
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    (nodes[id]?.predecessors || []).forEach(p => visit(p));
    result.push(id);
  }
  Object.keys(nodes).forEach(id => visit(id));
  return result;
}

function detectCycles(nodes) {
  const visiting = new Set(), visited = new Set();
  const cycles = [];
  function dfs(id, path) {
    if (visiting.has(id)) { cycles.push([...path, id]); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    (nodes[id]?.predecessors || []).forEach(p => dfs(p, [...path, id]));
    visiting.delete(id);
    visited.add(id);
  }
  Object.keys(nodes).forEach(id => dfs(id, []));
  return cycles;
}

function buildGraph(tasks) {
  const nodes = {};
  tasks.forEach(t => {
    nodes[t.id] = {
      id: t.id,
      duration: parseFloat(computePERT(+t.o, +t.m, +t.p).toFixed(4)),
      sigma: computeSigma(+t.o, +t.p),
      o: +t.o, m: +t.m, p: +t.p,
      predecessors: t.predecessors ? t.predecessors.split(",").map(s => s.trim()).filter(Boolean) : [],
      normalCost: +t.normalCost, crashCost: +t.crashCost, crashTime: +t.crashTime,
      resource: t.resource || "",
    };
  });
  return nodes;
}

function forwardPass(nodes) {
  const order = topoSort(nodes), ES = {}, EF = {};
  order.forEach(id => {
    const preds = nodes[id].predecessors;
    ES[id] = preds.length === 0 ? 0 : Math.max(...preds.map(p => EF[p] || 0));
    EF[id] = ES[id] + nodes[id].duration;
  });
  return { ES, EF, order };
}

function backwardPass(nodes, ES, EF, order) {
  const projectEnd = Math.max(...Object.values(EF));
  const LS = {}, LF = {};
  [...order].reverse().forEach(id => {
    const succs = Object.keys(nodes).filter(k => nodes[k].predecessors.includes(id));
    LF[id] = succs.length === 0 ? projectEnd : Math.min(...succs.map(s => LS[s]));
    LS[id] = LF[id] - nodes[id].duration;
  });
  return { LS, LF, projectEnd };
}

function computeSlack(ES, LS) {
  const slack = {};
  Object.keys(ES).forEach(id => { slack[id] = parseFloat((LS[id] - ES[id]).toFixed(4)); });
  return slack;
}

function findAllPaths(nodes) {
  const ends = Object.keys(nodes).filter(id => !Object.values(nodes).some(n => n.predecessors.includes(id)));
  const starts = Object.keys(nodes).filter(id => nodes[id].predecessors.length === 0);
  const paths = [];
  function dfs(cur, path) {
    path = [...path, cur];
    const succs = Object.keys(nodes).filter(k => nodes[k].predecessors.includes(cur));
    if (succs.length === 0 || ends.includes(cur)) { paths.push(path); return; }
    succs.forEach(s => dfs(s, path));
  }
  starts.forEach(s => dfs(s, []));
  return paths;
}

function layoutNodes(nodes) {
  const order = topoSort(nodes), levels = {};
  order.forEach(id => {
    const preds = nodes[id].predecessors;
    levels[id] = preds.length === 0 ? 0 : Math.max(...preds.map(p => levels[p])) + 1;
  });
  const maxLevel = Math.max(...Object.values(levels));
  const byLevel = {};
  order.forEach(id => {
    if (!byLevel[levels[id]]) byLevel[levels[id]] = [];
    byLevel[levels[id]].push(id);
  });
  const positions = {};
  const W = 1100, H = 480;
  const xStep = W / (maxLevel + 1);
  Object.keys(byLevel).forEach(lvl => {
    const items = byLevel[lvl];
    const yStep = H / (items.length + 1);
    items.forEach((id, i) => {
      positions[id] = { x: 80 + parseInt(lvl) * xStep, y: 60 + (i + 1) * yStep };
    });
  });
  return positions;
}

function computeFullCPM(tasks) {
  const nodes = buildGraph(tasks);
  const cycles = detectCycles(nodes);
  if (cycles.length > 0) throw new Error(`Circular dependency detected: ${cycles[0].join(" → ")}`);
  const { ES, EF, order } = forwardPass(nodes);
  const { LS, LF, projectEnd } = backwardPass(nodes, ES, EF, order);
  const slack = computeSlack(ES, LS);
  const criticalPath = order.filter(id => Math.abs(slack[id]) < 0.001);
  const positions = layoutNodes(nodes);
  const allPaths = findAllPaths(nodes);
  const pathDurations = allPaths.map(path => ({
    path, duration: path.reduce((s, id) => s + nodes[id].duration, 0),
  })).sort((a, b) => b.duration - a.duration);
  return { nodes, ES, EF, LS, LF, slack, criticalPath, projectEnd, positions, pathDurations, order };
}

function computeCrashPlan(nodes, targetDays) {
  const crashed = {};
  Object.keys(nodes).forEach(id => { crashed[id] = 0; });
  const crashLog = [];
  let totalExtra = 0;
  for (let day = 0; day < targetDays; day++) {
    const tempNodes = {};
    Object.keys(nodes).forEach(id => {
      tempNodes[id] = { ...nodes[id], duration: nodes[id].duration - crashed[id] };
    });
    const { ES: tES, EF: tEF, order: tOrd } = forwardPass(tempNodes);
    const { LS: tLS } = backwardPass(tempNodes, tES, tEF, tOrd);
    const tSlack = computeSlack(tES, tLS);
    const critTasks = tOrd.filter(id =>
      Math.abs(tSlack[id]) < 0.001 && (nodes[id].duration - crashed[id] - nodes[id].crashTime) > 0.001
    );
    if (critTasks.length === 0) { crashLog.push({ day: day + 1, note: "No further crashing possible" }); break; }
    const cpd = id => (nodes[id].crashCost - nodes[id].normalCost) / (nodes[id].duration - nodes[id].crashTime);
    const best = critTasks.reduce((a, b) => cpd(a) <= cpd(b) ? a : b);
    crashed[best] += 1;
    const cost = cpd(best);
    totalExtra += cost;
    crashLog.push({ day: day + 1, task: best, costPerDay: cost, cumCost: totalExtra });
  }
  return { crashLog, totalExtra };
}

// Monte Carlo simulation
function runMonteCarlo(tasks, iterations = 5000) {
  const nodes = buildGraph(tasks);
  const order = topoSort(nodes);
  const results = [];
  for (let i = 0; i < iterations; i++) {
    const dur = {};
    order.forEach(id => {
      const n = nodes[id];
      // Beta-like sample using normal approximation
      const mean = n.duration;
      const sigma = n.sigma;
      const u1 = Math.random(), u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      dur[id] = Math.max(n.crashTime, mean + sigma * z);
    });
    const EF = {};
    order.forEach(id => {
      const preds = nodes[id].predecessors;
      const es = preds.length === 0 ? 0 : Math.max(...preds.map(p => EF[p] || 0));
      EF[id] = es + dur[id];
    });
    results.push(Math.max(...Object.values(EF)));
  }
  results.sort((a, b) => a - b);
  const mean = results.reduce((s, v) => s + v, 0) / results.length;
  const variance = results.reduce((s, v) => s + (v - mean) ** 2, 0) / results.length;
  const p10 = results[Math.floor(iterations * 0.10)];
  const p50 = results[Math.floor(iterations * 0.50)];
  const p80 = results[Math.floor(iterations * 0.80)];
  const p90 = results[Math.floor(iterations * 0.90)];
  // Build histogram
  const min = results[0], max = results[results.length - 1];
  const bins = 30;
  const binSize = (max - min) / bins;
  const hist = Array(bins).fill(0).map((_, i) => ({
    x: min + i * binSize, count: 0,
    label: (min + i * binSize).toFixed(1),
  }));
  results.forEach(v => {
    const bin = Math.min(bins - 1, Math.floor((v - min) / binSize));
    hist[bin].count++;
  });
  return { results, mean, std: Math.sqrt(variance), p10, p50, p80, p90, hist, min, max };
}

// Validation
const INT_FIELDS = ["o", "m", "p", "normalCost", "crashCost", "crashTime"];
function isValidInt(val) { return /^-?\d+$/.test(String(val).trim()) && String(val).trim() !== ""; }

function validateTasks(tasks) {
  const errors = [];
  tasks.forEach((t, i) => {
    INT_FIELDS.forEach(f => {
      if (!isValidInt(t[f])) errors.push({ row: i, field: f, type: "invalid", msg: `Must be an integer` });
    });
    if (!String(t.id).trim()) errors.push({ row: i, field: "id", type: "invalid", msg: "ID cannot be empty" });
    // Check crash logic
    if (isValidInt(t.crashTime) && isValidInt(t.o) && isValidInt(t.m) && isValidInt(t.p)) {
      const dur = computePERT(+t.o, +t.m, +t.p);
      if (+t.crashTime >= dur) errors.push({ row: i, field: "crashTime", type: "warn", msg: `Crash time (${t.crashTime}) ≥ expected duration (${dur.toFixed(1)})` });
    }
    if (isValidInt(t.crashCost) && isValidInt(t.normalCost)) {
      if (+t.crashCost < +t.normalCost) errors.push({ row: i, field: "crashCost", type: "warn", msg: "Crash cost < normal cost" });
    }
    // Check predecessor exists (deferred — needs all IDs)
  });
  // Duplicate IDs
  const seen = {};
  tasks.forEach((t, i) => {
    const id = String(t.id).trim();
    if (id && seen[id] !== undefined) errors.push({ row: i, field: "id", type: "duplicate", msg: `Duplicate ID "${id}"` });
    else if (id) seen[id] = i;
  });
  // Unknown predecessors
  const allIds = new Set(tasks.map(t => String(t.id).trim()));
  tasks.forEach((t, i) => {
    if (!t.predecessors) return;
    t.predecessors.split(",").map(s => s.trim()).filter(Boolean).forEach(pred => {
      if (!allIds.has(pred)) errors.push({ row: i, field: "predecessors", type: "warn", msg: `Unknown predecessor "${pred}"` });
    });
  });
  return errors;
}

// ──────────────────────────────────────────────────────────────────────
// ─── Theme System ─────────────────────────────────────────────────────────────

const DARK = {
  name: "dark",
  bg: "#07090f",
  bg2: "#0a0e17",
  bg3: "#0d1520",
  bg4: "#111827",
  border: "#1a2535",
  border2: "#1e3050",
  text: "#c8d8e8",
  text2: "#7a9ab5",
  text3: "#445566",
  accent: "#4ade80",
  accentGlow: "#4ade8055",
  red: "#ff4444",
  orange: "#f59e0b",
  blue: "#7dd3fc",
  critBg: "#1a0505",
  nearBg: "#1a1000",
};

const LIGHT = {
  name: "light",
  bg: "#f0f4f8",
  bg2: "#ffffff",
  bg3: "#f8fafc",
  bg4: "#eef2f7",
  border: "#d1dce8",
  border2: "#b0c4d8",
  text: "#1a2535",
  text2: "#4a6580",
  text3: "#8aa0b5",
  accent: "#16a34a",
  accentGlow: "#16a34a44",
  red: "#dc2626",
  orange: "#d97706",
  blue: "#2563eb",
  critBg: "#fff1f1",
  nearBg: "#fffbeb",
};

function makeGlobalCSS(t) {
  return `
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700;800&family=Syne:wght@600;700;800&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; }
    body { background: ${t.bg}; font-family: 'JetBrains Mono', monospace; color: ${t.text}; font-size: 13px; transition: background 0.3s, color 0.3s; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: ${t.bg2}; }
    ::-webkit-scrollbar-thumb { background: ${t.border2}; border-radius: 3px; }
    ::selection { background: ${t.accent}33; }
    input, select, textarea { font-family: 'JetBrains Mono', monospace; }
    input:focus { outline: 2px solid ${t.accent} !important; outline-offset: -1px; }
    button { font-family: 'JetBrains Mono', monospace; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
    @keyframes slideIn { from { transform:translateX(-8px); opacity:0; } to { transform:translateX(0); opacity:1; } }
    .fade-in { animation: fadeIn 0.25s ease forwards; }
    .slide-in { animation: slideIn 0.2s ease forwards; }
    tr:hover td { background: ${t.bg4} !important; transition: background 0.1s; }
    .tab-btn:hover { color: ${t.accent} !important; }
    .btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 4px 20px ${t.accentGlow}; }
    .btn-primary:active { transform: translateY(0); }
    .ghost-btn:hover { border-color: ${t.accent} !important; color: ${t.accent} !important; }
    .del-btn:hover { border-color: ${t.red} !important; color: ${t.red} !important; }
    .tooltip { position: relative; }
    .tooltip:hover .tip { display: block; }
    .tip { display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
      background: ${t.bg4}; border: 1px solid ${t.border}; border-radius: 5px; padding: 6px 10px;
      font-size: 11px; color: ${t.text2}; white-space: nowrap; z-index: 100; pointer-events: none;
      box-shadow: 0 4px 16px #0006; }
    .tip::after { content:''; position:absolute; top:100%; left:50%; transform:translateX(-50%);
      border: 5px solid transparent; border-top-color: ${t.border}; }
  `;
}

// ──────────────────────────────────────────────────────────────────────
// ─── Shared UI Components ─────────────────────────────────────────────────────


function SectionHeader({ title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>{title}</div>
      {sub && <div style={{ fontSize: 11, opacity: 0.45, marginTop: 3, letterSpacing: "0.04em" }}>{sub}</div>}
    </div>
  );
}

function MetricCard({ value, label, color, sub, tooltip }) {
  return (
    <div className="tooltip" style={{
      background: "var(--bg2)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "16px 20px", position: "relative",
    }}>
      {tooltip && <span className="tip">{tooltip}</span>}
      <div style={{ fontSize: 26, fontWeight: 800, color: color || "var(--accent)", lineHeight: 1, wordBreak: "break-all" }}>{value}</div>
      <div style={{ fontSize: 10, opacity: 0.45, marginTop: 6, letterSpacing: "0.09em" }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: color || "var(--accent)", marginTop: 4, opacity: 0.7 }}>{sub}</div>}
    </div>
  );
}

function Table({ headers, children, style }) {
  return (
    <div style={{ overflowX: "auto", ...style }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>{headers.map(h => (
            <th key={h} style={{
              background: "var(--bg2)", color: "var(--accent)", padding: "10px 14px",
              textAlign: "left", borderBottom: "1px solid var(--border)",
              fontWeight: 700, letterSpacing: "0.07em", fontSize: 10,
              whiteSpace: "nowrap", fontFamily: "'JetBrains Mono', monospace",
            }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, style }) {
  return <td style={{ padding: "9px 14px", borderBottom: "1px solid var(--border)", fontSize: 13, whiteSpace: "nowrap", ...style }}>{children}</td>;
}

function Tag({ type }) {
  const map = {
    critical: { bg: "#ff4444", color: "#fff", label: "CRITICAL" },
    near: { bg: "#f59e0b", color: "#000", label: "NEAR-CRITICAL" },
    free: { bg: "var(--bg4)", color: "var(--text3)", label: "FREE" },
  };
  const s = map[type] || map.free;
  return <span style={{ background: s.bg, color: s.color, padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700 }}>{s.label}</span>;
}

function Banner({ type, children }) {
  const map = {
    error:   { bg: "var(--critBg)", border: "var(--red)",    color: "#ff9999" },
    warn:    { bg: "var(--nearBg)", border: "var(--orange)",  color: "#fbbf24" },
    success: { bg: "#0a1a0a",       border: "var(--accent)",  color: "var(--accent)" },
    info:    { bg: "var(--bg3)",    border: "var(--border2)", color: "var(--text2)" },
  };
  const s = map[type] || map.info;
  return (
    <div style={{
      background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6,
      padding: "10px 16px", marginBottom: 12, color: s.color,
      fontSize: 12, lineHeight: 1.6,
    }}>{children}</div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: "var(--bg3)", border: "1px solid var(--border)",
      borderRadius: 10, padding: 20, ...style,
    }}>{children}</div>
  );
}

function Btn({ children, onClick, variant = "primary", style }) {
  const base = {
    border: "none", cursor: "pointer", padding: "10px 22px", borderRadius: 6,
    fontSize: 13, fontWeight: 700, transition: "all 0.15s", letterSpacing: "0.03em",
  };
  const variants = {
    primary: { background: "var(--accent)", color: "#000", boxShadow: "0 0 16px var(--accentGlow)", ...base },
    ghost:   { background: "transparent", border: "1px solid var(--border2)", color: "var(--text2)", ...base },
    danger:  { background: "transparent", border: "1px solid var(--border)", color: "var(--text3)", ...base },
  };
  return <button className={`btn-${variant}`} style={{ ...variants[variant], ...style }} onClick={onClick}>{children}</button>;
}

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, color: "var(--text2)" }}>
      <div onClick={onChange} style={{
        width: 36, height: 20, borderRadius: 10, background: checked ? "var(--accent)" : "var(--bg4)",
        border: "1px solid var(--border)", position: "relative", cursor: "pointer",
        transition: "background 0.2s",
      }}>
        <div style={{
          position: "absolute", top: 2, left: checked ? 17 : 2, width: 14, height: 14,
          borderRadius: "50%", background: checked ? "#000" : "var(--text3)", transition: "left 0.2s",
        }} />
      </div>
      {label}
    </label>
  );
}

function NumberInput({ value, onChange, min, max, style }) {
  return (
    <input type="number" value={value} onChange={e => onChange(+e.target.value)} min={min} max={max}
      style={{
        background: "var(--bg2)", border: "1px solid var(--border2)", color: "var(--text)",
        padding: "8px 12px", borderRadius: 5, fontSize: 13, width: "100%", ...style,
      }}
    />
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── Input Tab ────────────────────────────────────────────────────────────────


const HEADERS = ["Task ID", "Predecessors", "Opt (O)", "Most Likely (M)", "Pessimistic (P)", "Normal Cost", "Crash Cost", "Crash Time", "Resource", ""];
const FIELDS  = ["id", "predecessors", "o", "m", "p", "normalCost", "crashCost", "crashTime", "resource"];
const FIELD_HINTS = {
  id: "Unique task identifier (e.g. A, B, Task1)",
  predecessors: "Comma-separated IDs of tasks that must finish first",
  o: "Optimistic duration (integer days)",
  m: "Most likely duration (integer days)",
  p: "Pessimistic duration (integer days)",
  normalCost: "Normal cost (Rs. 000)",
  crashCost: "Crash cost when accelerated (Rs. 000)",
  crashTime: "Minimum duration after full crash (integer days)",
  resource: "Optional: resource name for histogram",
};

function InputTab({ tasks, setTasks, onGenerate, validationErrors, generated }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const dragNode = useRef(null);

  function updateTask(i, field, val) {
    setTasks(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t));
  }

  function addTask() {
    const usedIds = new Set(tasks.map(t => t.id));
    let c = 65;
    while (usedIds.has(String.fromCharCode(c))) c++;
    setTasks(prev => [...prev, {
      id: String.fromCharCode(c), predecessors: "", o: 1, m: 3, p: 6,
      normalCost: 100, crashCost: 150, crashTime: 2, resource: "",
    }]);
  }

  function removeTask(i) {
    setTasks(prev => prev.filter((_, idx) => idx !== i));
  }

  function clearAll() {
    if (confirm("Clear all tasks?")) setTasks([]);
  }

  function loadDefault() {
    setTasks(DEFAULT_TASKS);
  }

  // Drag reorder
  function onDragStart(e, i) {
    dragNode.current = i;
    setDragIdx(i);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragEnter(i) { setDragOver(i); }
  function onDragEnd() {
    if (dragNode.current !== null && dragOver !== null && dragNode.current !== dragOver) {
      setTasks(prev => {
        const next = [...prev];
        const [item] = next.splice(dragNode.current, 1);
        next.splice(dragOver, 0, item);
        return next;
      });
    }
    setDragIdx(null);
    setDragOver(null);
    dragNode.current = null;
  }

  function getCellErr(row, field) {
    return validationErrors.find(e => e.row === row && e.field === field) || null;
  }

  function cellStyle(row, field) {
    const err = getCellErr(row, field);
    const base = {
      background: "var(--bg2)", border: "1px solid var(--border2)", color: "var(--text)",
      padding: "6px 9px", borderRadius: 4, fontSize: 12, width: "100%",
      fontFamily: "'JetBrains Mono', monospace",
    };
    if (!err) return base;
    if (err.type === "duplicate") return { ...base, border: "2px solid #ff3333", background: "#2a080820", color: "#ff9999" };
    if (err.type === "invalid")   return { ...base, border: "2px solid #f59e0b", background: "#1e120020", color: "#fbbf24" };
    if (err.type === "warn")      return { ...base, border: "2px solid #f59e0b88", background: "#1e120010" };
    return base;
  }

  const invalidErrors    = validationErrors.filter(e => e.type === "invalid");
  const duplicateErrors  = validationErrors.filter(e => e.type === "duplicate");
  const warnErrors       = validationErrors.filter(e => e.type === "warn");
  const hasBlocker       = invalidErrors.length > 0 || duplicateErrors.length > 0;

  return (
    <div className="fade-in">
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>Task Input</div>
          <div style={{ fontSize: 11, opacity: 0.4, marginTop: 3 }}>Drag rows to reorder · All numeric fields must be integers · Costs in Rs. (000)</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={loadDefault} style={{ fontSize: 12, padding: "8px 14px" }}>Load Example</Btn>
          <Btn variant="ghost" onClick={clearAll}    style={{ fontSize: 12, padding: "8px 14px" }}>Clear All</Btn>
          <Btn variant="ghost" onClick={addTask}     style={{ fontSize: 12, padding: "8px 14px" }}>+ Add Task</Btn>
          <Btn variant="primary" onClick={onGenerate} style={{ padding: "10px 28px", fontSize: 14 }}>⚡ Generate</Btn>
        </div>
      </div>

      {/* Banners */}
      {duplicateErrors.length > 0 && (
        <Banner type="error">
          <b>✕ Duplicate Task IDs — </b>
          {duplicateErrors.map((e, i) => <span key={i}> Row {e.row + 1} (<b style={{ color: "#ff6666" }}>"{tasks[e.row]?.id}"</b>){i < duplicateErrors.length - 1 ? "," : ""}</span>)}
          . Each Task ID must be unique.
        </Banner>
      )}
      {invalidErrors.length > 0 && (
        <Banner type="warn">
          <b>⚠ {invalidErrors.length} invalid value{invalidErrors.length > 1 ? "s" : ""} — </b>
          Fields highlighted in <b style={{ color: "#f59e0b" }}>orange</b> must be whole numbers (integers).
        </Banner>
      )}
      {warnErrors.length > 0 && (
        <Banner type="info">
          <b>ℹ Logic warnings: </b>
          {warnErrors.map((e, i) => <span key={i}> Row {e.row + 1} {e.field}: {e.msg}{i < warnErrors.length - 1 ? " · " : ""}</span>)}
        </Banner>
      )}
      {generated && !hasBlocker && (
        <Banner type="success">✓ Generated successfully — switch to any tab to view results.</Banner>
      )}

      {/* Table */}
      <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid var(--border)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>⠿</th>
              {HEADERS.slice(0, -1).map(h => <th key={h} style={thStyle}>{h}</th>)}
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t, i) => {
              const isDragging = dragIdx === i;
              const isOver = dragOver === i;
              return (
                <tr key={i}
                  draggable
                  onDragStart={e => onDragStart(e, i)}
                  onDragEnter={() => onDragEnter(i)}
                  onDragEnd={onDragEnd}
                  onDragOver={e => e.preventDefault()}
                  style={{
                    background: isDragging ? "var(--bg4)" : isOver ? "var(--nearBg)" : i % 2 === 0 ? "var(--bg2)" : "var(--bg3)",
                    opacity: isDragging ? 0.5 : 1,
                    borderTop: isOver ? "2px solid var(--accent)" : "none",
                    transition: "all 0.1s",
                  }}
                >
                  <td style={{ ...tdStyle, cursor: "grab", color: "var(--text3)", fontSize: 16, textAlign: "center" }}>⠿</td>
                  {FIELDS.map(f => {
                    const err = getCellErr(i, f);
                    return (
                      <td key={f} style={{ ...tdStyle, position: "relative", padding: "6px 8px" }}>
                        <div className="tooltip" style={{ position: "relative" }}>
                          <input
                            style={cellStyle(i, f)}
                            value={t[f]}
                            onChange={e => updateTask(i, f, e.target.value)}
                            placeholder={f === "predecessors" ? "e.g. A,B" : f === "resource" ? "optional" : ""}
                          />
                          <span className="tip">{err ? err.msg : FIELD_HINTS[f]}</span>
                          {err && err.type !== "warn" && (
                            <span style={{
                              position: "absolute", top: 3, right: 5, fontSize: 8,
                              fontWeight: 900, letterSpacing: "0.05em", pointerEvents: "none",
                              color: err.type === "duplicate" ? "#ff4444" : "#f59e0b",
                            }}>
                              {err.type === "duplicate" ? "DUP" : "ERR"}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td style={tdStyle}>
                    <button className="del-btn" onClick={() => removeTask(i)} style={{
                      background: "transparent", border: "1px solid var(--border)", color: "var(--text3)",
                      padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12, transition: "all 0.15s",
                    }}>✕</button>
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 && (
              <tr><td colSpan={HEADERS.length + 1} style={{ ...tdStyle, textAlign: "center", opacity: 0.3, padding: 32 }}>
                No tasks yet — click "Load Example" or "+ Add Task"
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 20, marginTop: 14, flexWrap: "wrap" }}>
        {[
          { color: "#f59e0b", bg: "#1e120020", label: "Non-integer value" },
          { color: "#ff3333", bg: "#2a080820", label: "Duplicate Task ID" },
          { color: "#f59e0b88", bg: "transparent", label: "Logic warning" },
        ].map(l => (
          <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--text3)" }}>
            <div style={{ width: 14, height: 14, border: `2px solid ${l.color}`, background: l.bg, borderRadius: 3 }} />
            {l.label}
          </div>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--text3)" }}>⠿ Drag rows to reorder</div>
      </div>
    </div>
  );
}

const thStyle = {
  background: "var(--bg2)", color: "var(--accent)", padding: "10px 12px",
  textAlign: "left", borderBottom: "1px solid var(--border)",
  fontWeight: 700, fontSize: 10, letterSpacing: "0.07em", whiteSpace: "nowrap",
};
const tdStyle = { padding: "5px 8px", borderBottom: "1px solid var(--border)", fontSize: 13 };

const DEFAULT_TASKS = [
  { id: "A", predecessors: "", o: 2, m: 4, p: 12, normalCost: 250, crashCost: 350, crashTime: 5, resource: "Team A" },
  { id: "B", predecessors: "", o: 4, m: 6, p: 14, normalCost: 400, crashCost: 600, crashTime: 6, resource: "Team B" },
  { id: "C", predecessors: "A", o: 6, m: 9, p: 18, normalCost: 500, crashCost: 650, crashTime: 8, resource: "Team A" },
  { id: "D", predecessors: "A,B", o: 9, m: 10, p: 11, normalCost: 500, crashCost: 600, crashTime: 9, resource: "Team C" },
  { id: "E", predecessors: "B", o: 6, m: 15, p: 18, normalCost: 700, crashCost: 800, crashTime: 13, resource: "Team B" },
  { id: "F", predecessors: "C,D", o: 17, m: 26, p: 29, normalCost: 800, crashCost: 900, crashTime: 23, resource: "Team D" },
  { id: "G", predecessors: "C,D,E", o: 7, m: 21, p: 29, normalCost: 750, crashCost: 950, crashTime: 19, resource: "Team C" },
  { id: "H", predecessors: "F,G", o: 16, m: 18, p: 20, normalCost: 650, crashCost: 800, crashTime: 15, resource: "Team D" },
];

// ──────────────────────────────────────────────────────────────────────
// ─── Network Graph with Zoom / Pan ───────────────────────────────────────────


function NetworkGraph({ computed }) {
  const { nodes, ES, EF, LS, LF, slack, criticalPath, positions } = computed;
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const lastPos = useRef(null);
  const svgRef = useRef(null);

  const W = 1200, H = 520;

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform(prev => ({
      ...prev,
      scale: Math.min(3, Math.max(0.3, prev.scale * delta)),
    }));
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    setIsPanning(true);
    lastPos.current = { x: e.clientX, y: e.clientY };
  }

  function onMouseMove(e) {
    if (!isPanning || !lastPos.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    lastPos.current = { x: e.clientX, y: e.clientY };
  }

  function onMouseUp() { setIsPanning(false); lastPos.current = null; }
  function resetView() { setTransform({ x: 0, y: 0, scale: 1 }); }
  function zoomIn()  { setTransform(prev => ({ ...prev, scale: Math.min(3, prev.scale * 1.2) })); }
  function zoomOut() { setTransform(prev => ({ ...prev, scale: Math.max(0.3, prev.scale * 0.8) })); }

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>Network Diagram</div>
          <div style={{ fontSize: 11, opacity: 0.4, marginTop: 3 }}>Scroll to zoom · Drag to pan · Node shows ES|EF (top) and LS|LF (bottom)</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {[["−", zoomOut], ["+", zoomIn], ["⟳", resetView]].map(([label, fn]) => (
            <button key={label} onClick={fn} style={{
              background: "var(--bg2)", border: "1px solid var(--border2)", color: "var(--text)",
              width: 32, height: 32, borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{label}</button>
          ))}
          <span style={{ fontSize: 11, color: "var(--text3)", marginLeft: 4 }}>{Math.round(transform.scale * 100)}%</span>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 18, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          ["var(--red)", "Critical Path"],
          ["var(--border2)", "Non-Critical"],
          ["#f59e0b", "Near-Critical (slack ≤ 2)"],
        ].map(([c, l]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--text2)" }}>
            <div style={{ width: 24, height: 3, background: c, borderRadius: 2 }} />{l}
          </div>
        ))}
      </div>

      <div
        ref={svgRef}
        style={{
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10,
          overflow: "hidden", cursor: isPanning ? "grabbing" : "grab", position: "relative",
          height: 520, userSelect: "none",
        }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
          <defs>
            <marker id="arrowRed"  markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L0,8 L10,4 z" fill="var(--red)" /></marker>
            <marker id="arrowGray" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L0,8 L10,4 z" fill="var(--border2)" /></marker>
            <marker id="arrowAmber" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L0,8 L10,4 z" fill="#f59e0b" /></marker>
          </defs>

          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
            {/* Edges */}
            {Object.keys(nodes).map(id =>
              nodes[id].predecessors.map(pred => {
                const from = positions[pred], to = positions[id];
                if (!from || !to) return null;
                const isCrit = criticalPath.includes(id) && criticalPath.includes(pred);
                const isNearCrit = !isCrit && (Math.abs(slack[id]) <= 2 || Math.abs(slack[pred]) <= 2);
                const color = isCrit ? "var(--red)" : isNearCrit ? "#f59e0b" : "var(--border2)";
                const marker = isCrit ? "url(#arrowRed)" : isNearCrit ? "url(#arrowAmber)" : "url(#arrowGray)";
                const dx = to.x - from.x, dy = to.y - from.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                const nx = dx / len, ny = dy / len;
                const r = 46;
                // Curved edges
                const mx = (from.x + to.x) / 2 - ny * 20;
                const my = (from.y + to.y) / 2 + nx * 20;
                return (
                  <path key={`${pred}-${id}`}
                    d={`M ${from.x + nx * r} ${from.y + ny * r} Q ${mx} ${my} ${to.x - nx * r} ${to.y - ny * r}`}
                    stroke={color} strokeWidth={isCrit ? 2.5 : 1.5} fill="none"
                    markerEnd={marker}
                  />
                );
              })
            )}

            {/* Nodes */}
            {Object.keys(nodes).map(id => {
              const { x, y } = positions[id];
              const isCrit = criticalPath.includes(id);
              const isNear = !isCrit && slack[id] <= 2;
              const nw = 92, nh = 84;
              const borderColor = isCrit ? "var(--red)" : isNear ? "#f59e0b" : "var(--border2)";
              const bgColor = isCrit ? "var(--critBg)" : isNear ? "var(--nearBg)" : "var(--bg3)";

              return (
                <g key={id}>
                  {/* Shadow */}
                  <rect x={x - nw/2 + 2} y={y - nh/2 + 2} width={nw} height={nh} rx={7} fill="#00000033" />
                  {/* Main box */}
                  <rect x={x - nw/2} y={y - nh/2} width={nw} height={nh} rx={7}
                    fill={bgColor} stroke={borderColor} strokeWidth={isCrit ? 2.5 : 1.5} />
                  {/* Dividers */}
                  <line x1={x - nw/2} y1={y - 4} x2={x + nw/2} y2={y - 4} stroke={borderColor} strokeWidth={0.8} opacity={0.4} />
                  <line x1={x} y1={y - nh/2} x2={x} y2={y + nh/2} stroke={borderColor} strokeWidth={0.8} opacity={0.4} />

                  {/* Task ID */}
                  <text x={x} y={y - 28} textAnchor="middle" fontSize={16} fontWeight={800}
                    fill={isCrit ? "var(--red)" : isNear ? "#f59e0b" : "var(--accent)"}
                    fontFamily="JetBrains Mono, monospace">{id}</text>

                  {/* Duration */}
                  <text x={x} y={y - 14} textAnchor="middle" fontSize={9} fill="var(--text3)"
                    fontFamily="JetBrains Mono, monospace">{nodes[id].duration.toFixed(1)}d · slack:{slack[id].toFixed(1)}</text>

                  {/* ES | EF */}
                  <text x={x - 23} y={y + 12} textAnchor="middle" fontSize={10} fill="var(--blue)"
                    fontFamily="JetBrains Mono, monospace">{ES[id].toFixed(1)}</text>
                  <text x={x + 23} y={y + 12} textAnchor="middle" fontSize={10} fill="var(--blue)"
                    fontFamily="JetBrains Mono, monospace">{EF[id].toFixed(1)}</text>

                  {/* LS | LF */}
                  <text x={x - 23} y={y + 28} textAnchor="middle" fontSize={10}
                    fill={isCrit ? "var(--red)" : "var(--text3)"}
                    fontFamily="JetBrains Mono, monospace">{LS[id].toFixed(1)}</text>
                  <text x={x + 23} y={y + 28} textAnchor="middle" fontSize={10}
                    fill={isCrit ? "var(--red)" : "var(--text3)"}
                    fontFamily="JetBrains Mono, monospace">{LF[id].toFixed(1)}</text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8 }}>
        Top half: <span style={{ color: "var(--blue)" }}>ES | EF</span> &nbsp;·&nbsp;
        Bottom half: <span style={{ color: "var(--text2)" }}>LS | LF</span> &nbsp;·&nbsp;
        Center: duration · slack
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── Gantt Chart ──────────────────────────────────────────────────────────────


function GanttChart({ computed }) {
  const { nodes, ES, EF, LS, LF, slack, criticalPath, projectEnd } = computed;
  const [showSlack, setShowSlack] = useState(true);
  const [showLS, setShowLS] = useState(false);
  const tasks = Object.keys(nodes);

  const BAR_H = 28, ROW_H = 40, LABEL_W = 120, HEADER_H = 40;
  const CHART_W = 860;
  const scale = CHART_W / projectEnd;
  const totalH = tasks.length * ROW_H + HEADER_H + 20;

  // Tick marks
  const tickCount = Math.min(20, Math.ceil(projectEnd));
  const tickStep = Math.ceil(projectEnd / tickCount);
  const ticks = [];
  for (let t = 0; t <= projectEnd; t += tickStep) ticks.push(t);
  if (ticks[ticks.length - 1] < projectEnd) ticks.push(Math.ceil(projectEnd));

  const colors = {
    critical: { bar: "#ff4444", slack: "#ff444433", ls: "#ff444422" },
    near:     { bar: "#f59e0b", slack: "#f59e0b33", ls: "#f59e0b22" },
    free:     { bar: "var(--accent)", slack: "var(--accent)33", ls: "var(--accent)22" },
  };

  function getColor(id) {
    if (criticalPath.includes(id)) return colors.critical;
    if (slack[id] <= 2) return colors.near;
    return colors.free;
  }

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>Gantt Chart</div>
          <div style={{ fontSize: 11, opacity: 0.4, marginTop: 3 }}>Early start schedule · Bars show task duration · Extensions show slack/float</div>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, cursor: "pointer", color: "var(--text2)" }}>
            <input type="checkbox" checked={showSlack} onChange={() => setShowSlack(v => !v)} />
            Show slack
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, cursor: "pointer", color: "var(--text2)" }}>
            <input type="checkbox" checked={showLS} onChange={() => setShowLS(v => !v)} />
            Show late start
          </label>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 18, marginBottom: 14, flexWrap: "wrap" }}>
        {[
          ["#ff4444", "Critical task"],
          ["#f59e0b", "Near-critical (slack ≤ 2)"],
          ["var(--accent)", "Free float task"],
          ["var(--text3)", "Slack/float extension"],
        ].map(([c, l]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--text2)" }}>
            <div style={{ width: 16, height: 12, background: c, borderRadius: 2 }} />{l}
          </div>
        ))}
      </div>

      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, overflow: "auto" }}>
        <div style={{ display: "flex", minWidth: LABEL_W + CHART_W + 40 }}>
          {/* Labels */}
          <div style={{ width: LABEL_W, flexShrink: 0 }}>
            <div style={{ height: HEADER_H, borderBottom: "1px solid var(--border)", background: "var(--bg2)" }} />
            {tasks.map(id => {
              const isCrit = criticalPath.includes(id);
              const isNear = !isCrit && slack[id] <= 2;
              return (
                <div key={id} style={{
                  height: ROW_H, display: "flex", alignItems: "center",
                  padding: "0 12px", borderBottom: "1px solid var(--border)",
                  background: isCrit ? "var(--critBg)" : isNear ? "var(--nearBg)" : undefined,
                }}>
                  <span style={{
                    fontWeight: 700, fontSize: 13,
                    color: isCrit ? "var(--red)" : isNear ? "#f59e0b" : "var(--accent)",
                    marginRight: 6,
                  }}>{id}</span>
                  <span style={{ fontSize: 10, color: "var(--text3)" }}>{nodes[id].duration.toFixed(1)}d</span>
                </div>
              );
            })}
          </div>

          {/* Chart area */}
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            {/* Header with day ticks */}
            <div style={{ height: HEADER_H, borderBottom: "1px solid var(--border)", position: "relative", background: "var(--bg2)" }}>
              {ticks.map(t => (
                <div key={t} style={{
                  position: "absolute", left: t * scale,
                  top: 0, height: "100%",
                  borderLeft: "1px solid var(--border)",
                }}>
                  <span style={{ position: "absolute", top: 6, left: 4, fontSize: 10, color: "var(--text3)", whiteSpace: "nowrap" }}>
                    Day {t}
                  </span>
                </div>
              ))}
              {/* Critical path end marker */}
              <div style={{
                position: "absolute", left: projectEnd * scale - 1, top: 0, height: "100%",
                borderLeft: "2px solid var(--red)", opacity: 0.6,
              }} />
            </div>

            {/* Task rows */}
            {tasks.map((id, rowIdx) => {
              const isCrit = criticalPath.includes(id);
              const isNear = !isCrit && slack[id] <= 2;
              const c = getColor(id);
              const es = ES[id], ef = EF[id], ls = LS[id], lf = LF[id];
              const sl = slack[id];
              const barLeft = es * scale;
              const barW = (ef - es) * scale;
              const slackW = sl * scale;

              return (
                <div key={id} style={{
                  height: ROW_H, position: "relative", borderBottom: "1px solid var(--border)",
                  background: isCrit ? "var(--critBg)" : isNear ? "var(--nearBg)" : undefined,
                }}>
                  {/* Tick grid lines */}
                  {ticks.map(t => (
                    <div key={t} style={{
                      position: "absolute", left: t * scale, top: 0, height: "100%",
                      borderLeft: "1px solid var(--border)", opacity: 0.3,
                    }} />
                  ))}

                  {/* Late start bar (optional) */}
                  {showLS && sl > 0 && (
                    <div style={{
                      position: "absolute",
                      left: ls * scale, width: (lf - ls) * scale,
                      top: (ROW_H - BAR_H) / 2, height: BAR_H,
                      background: c.ls, border: `1px dashed ${c.bar}55`,
                      borderRadius: 4, opacity: 0.5,
                    }} />
                  )}

                  {/* Slack extension */}
                  {showSlack && sl > 0.01 && (
                    <div style={{
                      position: "absolute",
                      left: ef * scale, width: slackW,
                      top: (ROW_H - BAR_H * 0.5) / 2 + BAR_H * 0.25, height: BAR_H * 0.5,
                      background: c.slack, borderRadius: "0 4px 4px 0",
                      border: `1px dashed var(--text3)44`,
                    }}>
                      {slackW > 24 && (
                        <span style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)", fontSize: 9, color: "var(--text3)", whiteSpace: "nowrap" }}>
                          +{sl.toFixed(1)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Main bar */}
                  <div style={{
                    position: "absolute",
                    left: barLeft, width: Math.max(2, barW),
                    top: (ROW_H - BAR_H) / 2, height: BAR_H,
                    background: c.bar, borderRadius: 5,
                    display: "flex", alignItems: "center",
                    boxShadow: isCrit ? `0 0 8px ${c.bar}55` : "none",
                  }}>
                    {barW > 30 && (
                      <span style={{ paddingLeft: 7, fontSize: 10, color: isCrit ? "#fff" : "#000", fontWeight: 700, whiteSpace: "nowrap" }}>
                        {es.toFixed(0)}→{ef.toFixed(0)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16 }}>
        {[
          { label: "PROJECT DURATION", val: `${projectEnd.toFixed(1)} days`, color: "var(--accent)" },
          { label: "CRITICAL TASKS", val: criticalPath.join(" → "), color: "var(--red)" },
          { label: "TOTAL NORMAL COST", val: `Rs. ${Object.values(nodes).reduce((s,n)=>s+n.normalCost,0).toLocaleString()}k`, color: "var(--text)" },
        ].map(m => (
          <div key={m.label} style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 18px" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: m.color, wordBreak: "break-all" }}>{m.val}</div>
            <div style={{ fontSize: 10, opacity: 0.4, marginTop: 5, letterSpacing: "0.09em" }}>{m.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── CPM Analysis Tab ─────────────────────────────────────────────────────────


function CPMAnalysis({ computed }) {
  const { nodes, ES, EF, LS, LF, slack, criticalPath, projectEnd, pathDurations } = computed;

  const totalNormal = Object.values(nodes).reduce((s, n) => s + n.normalCost, 0);
  const nearCritCount = Object.values(slack).filter(s => s > 0 && s <= 2).length;
  const projSigma = Math.sqrt(criticalPath.reduce((s, id) => s + nodes[id].sigma ** 2, 0));

  return (
    <div className="fade-in">
      <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>CPM Analysis</div>
      <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 20 }}>Forward/backward pass · Slack · Float · Path enumeration</div>

      {/* Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}>
        <MetricCard value={projectEnd.toFixed(1)} label="PROJECT DURATION (DAYS)"
          color="var(--accent)" tooltip="Longest path through the network" />
        <MetricCard value={criticalPath.join("→")} label="CRITICAL PATH"
          color="var(--red)" tooltip="Tasks with zero float — any delay cascades to project end" />
        <MetricCard value={nearCritCount} label="NEAR-CRITICAL TASKS (SLACK≤2)"
          color="var(--orange)" tooltip="Tasks at risk of becoming critical with minor delays" />
        <MetricCard value={`±${projSigma.toFixed(2)}`} label="CRITICAL PATH STD DEV"
          color="var(--blue)" tooltip="Statistical uncertainty on the critical path duration" />
      </div>

      {/* PERT table */}
      <div style={{ fontFamily: "'Syne'", fontSize: 16, fontWeight: 700, marginBottom: 10 }}>PERT Estimates</div>
      <Table headers={["Task","O","M","P","Expected Duration","Std Dev σ","Variance σ²","Predecessors"]} style={{ marginBottom: 24 }}>
        {Object.keys(nodes).map(id => {
          const n = nodes[id];
          const sd = n.sigma;
          return (
            <tr key={id}>
              <Td style={{ color: "var(--accent)", fontWeight: 800 }}>{id}</Td>
              <Td>{n.o}</Td><Td>{n.m}</Td><Td>{n.p}</Td>
              <Td style={{ fontWeight: 700 }}>{n.duration.toFixed(2)}</Td>
              <Td>{sd.toFixed(3)}</Td>
              <Td>{(sd*sd).toFixed(4)}</Td>
              <Td style={{ color: "var(--text2)" }}>{n.predecessors.join(", ") || "—"}</Td>
            </tr>
          );
        })}
      </Table>

      {/* Forward/Backward pass */}
      <div style={{ fontFamily: "'Syne'", fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Forward / Backward Pass & Slack</div>
      <Table headers={["Task","Duration","ES","EF","LS","LF","Total Float","Status"]} style={{ marginBottom: 24 }}>
        {Object.keys(nodes).map(id => {
          const isCrit = criticalPath.includes(id);
          const sl = slack[id];
          const isNear = !isCrit && sl <= 2;
          return (
            <tr key={id} style={{ background: isCrit ? "var(--critBg)" : isNear ? "var(--nearBg)" : undefined }}>
              <Td style={{ color: isCrit ? "var(--red)" : "var(--accent)", fontWeight: 800 }}>{id}</Td>
              <Td style={{ fontWeight: 600 }}>{nodes[id].duration.toFixed(2)}</Td>
              <Td style={{ color: "var(--blue)" }}>{ES[id].toFixed(2)}</Td>
              <Td style={{ color: "var(--blue)" }}>{EF[id].toFixed(2)}</Td>
              <Td style={{ color: isCrit ? "var(--red)" : "var(--text2)" }}>{LS[id].toFixed(2)}</Td>
              <Td style={{ color: isCrit ? "var(--red)" : "var(--text2)" }}>{LF[id].toFixed(2)}</Td>
              <Td style={{ fontWeight: 700, color: isCrit ? "var(--red)" : isNear ? "var(--orange)" : "var(--accent)" }}>
                {sl.toFixed(2)}
              </Td>
              <Td><Tag type={isCrit ? "critical" : isNear ? "near" : "free"} /></Td>
            </tr>
          );
        })}
      </Table>

      {/* All paths */}
      <div style={{ fontFamily: "'Syne'", fontSize: 16, fontWeight: 700, marginBottom: 10 }}>All Network Paths</div>
      <Table headers={["#","Path","Duration","vs Critical","Status"]}>
        {pathDurations.map((p, i) => {
          const diff = p.duration - pathDurations[0].duration;
          return (
            <tr key={i} style={{ background: i === 0 ? "var(--critBg)" : undefined }}>
              <Td style={{ color: "var(--text3)" }}>{i + 1}</Td>
              <Td style={{ color: i === 0 ? "#ff8888" : "var(--text2)", fontWeight: i === 0 ? 700 : 400 }}>{p.path.join(" → ")}</Td>
              <Td style={{ fontWeight: 700, color: i === 0 ? "var(--red)" : "var(--text)" }}>{p.duration.toFixed(2)}</Td>
              <Td style={{ color: "var(--text3)" }}>{i === 0 ? "—" : `${diff.toFixed(2)} days slack`}</Td>
              <Td>{i === 0 ? <Tag type="critical" /> : <Tag type="free" />}</Td>
            </tr>
          );
        })}
      </Table>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── Crash Analysis Tab ───────────────────────────────────────────────────────


function CrashAnalysis({ computed }) {
  const { nodes, criticalPath, projectEnd } = computed;
  const [crashDays, setCrashDays] = useState(4);

  const maxCrashable = criticalPath.reduce((s, id) => {
    const n = nodes[id];
    return s + Math.max(0, n.duration - n.crashTime);
  }, 0);

  const safeTarget = Math.min(crashDays, Math.floor(maxCrashable));
  const crashPlan = computeCrashPlan(nodes, safeTarget);
  const nextDayPlan = computeCrashPlan(nodes, safeTarget + 1);
  const nextEntry = nextDayPlan.crashLog[safeTarget];

  const crashCPD = id => {
    const n = nodes[id];
    const avail = n.duration - n.crashTime;
    if (avail <= 0) return Infinity;
    return (n.crashCost - n.normalCost) / avail;
  };
  const minCPD = Math.min(...criticalPath.map(crashCPD).filter(v => v !== Infinity));

  return (
    <div className="fade-in">
      <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>Crash Analysis</div>
      <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 20 }}>Time–cost tradeoff · Cheapest-first crashing strategy</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
        {/* Left: crash options table */}
        <div>
          <div style={{ fontSize: 12, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 10 }}>CRITICAL PATH CRASH OPTIONS</div>
          <Table headers={["Task","Normal Dur","Crash Limit","Max Reduce","Cost/Day (Rs.000)"]}>
            {criticalPath.map(id => {
              const n = nodes[id];
              const avail = n.duration - n.crashTime;
              const cpd = crashCPD(id);
              const isBest = cpd === minCPD;
              return (
                <tr key={id}>
                  <Td style={{ color: "var(--red)", fontWeight: 800 }}>{id}</Td>
                  <Td>{n.duration.toFixed(1)}</Td>
                  <Td>{n.crashTime}</Td>
                  <Td style={{ color: avail <= 0 ? "var(--text3)" : "var(--text)" }}>{avail.toFixed(1)}d</Td>
                  <Td style={{ color: isBest ? "var(--accent)" : "var(--text)", fontWeight: isBest ? 800 : 400 }}>
                    {cpd === Infinity ? "N/A" : cpd.toFixed(2)}
                    {isBest && <span style={{ marginLeft: 6, fontSize: 9, color: "var(--accent)" }}>CHEAPEST</span>}
                  </Td>
                </tr>
              );
            })}
          </Table>
        </div>

        {/* Right: controls */}
        <div>
          <div style={{ fontSize: 12, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 10 }}>SIMULATION CONTROLS</div>
          <Card>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, letterSpacing: "0.06em" }}>
                TARGET REDUCTION (DAYS) — max crashable: {Math.floor(maxCrashable)}d
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
                <input type="range" min={0} max={Math.ceil(maxCrashable)} value={crashDays}
                  onChange={e => setCrashDays(+e.target.value)}
                  style={{ flex: 1, accentColor: "var(--accent)" }} />
                <input type="number" value={crashDays} onChange={e => setCrashDays(Math.max(0, Math.min(Math.ceil(maxCrashable), +e.target.value)))}
                  style={{
                    width: 64, background: "var(--bg2)", border: "1px solid var(--border2)",
                    color: "var(--text)", padding: "6px 8px", borderRadius: 4, fontSize: 14, fontWeight: 700, textAlign: "center",
                    fontFamily: "'JetBrains Mono', monospace",
                  }} min={0} max={Math.ceil(maxCrashable)} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[
                { val: projectEnd.toFixed(1), label: "CURRENT", color: "var(--text)" },
                { val: Math.max(0, projectEnd - safeTarget).toFixed(1), label: "TARGET", color: "var(--orange)" },
              ].map(m => (
                <div key={m.label} style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 7, padding: "12px 16px" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: m.color }}>{m.val}d</div>
                  <div style={{ fontSize: 10, opacity: 0.4, marginTop: 4, letterSpacing: "0.08em" }}>{m.label} DURATION</div>
                </div>
              ))}
              <div style={{ gridColumn: "1/-1", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 7, padding: "12px 16px" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "var(--red)" }}>
                  {crashPlan.totalExtra > 0 ? `+${crashPlan.totalExtra.toFixed(1)}k` : "—"}
                </div>
                <div style={{ fontSize: 10, opacity: 0.4, marginTop: 4, letterSpacing: "0.08em" }}>ADDITIONAL CRASH COST (Rs. 000)</div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Crash log */}
      {crashPlan.crashLog.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 10 }}>CRASH SCHEDULE — CHEAPEST FIRST</div>
          <Table headers={["Day Reduction","Task Crashed","Cost/Day (Rs.000)","Cumulative Extra Cost"]} style={{ marginBottom: 20 }}>
            {crashPlan.crashLog.map((log, i) => (
              <tr key={i}>
                <Td style={{ color: "var(--text3)" }}>−{log.day} day{log.day > 1 ? "s" : ""}</Td>
                <Td style={{ color: log.note ? "var(--text3)" : "var(--red)", fontWeight: 700 }}>{log.task || log.note}</Td>
                <Td>{log.costPerDay ? log.costPerDay.toFixed(2) : "—"}</Td>
                <Td style={{ fontWeight: 700, color: "var(--orange)" }}>{log.cumCost ? `${log.cumCost.toFixed(2)}k` : "—"}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      {/* +1 more day */}
      {nextEntry && nextEntry.task && (
        <Card style={{ background: "#0a1a0a", border: "1px solid #1a3a1a" }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            <b>+1 more day recommendation:</b>
            <span style={{ color: "var(--accent)", fontWeight: 800, marginLeft: 10, fontSize: 16 }}>Task {nextEntry.task}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text2)" }}>
            Additional cost: <b style={{ color: "var(--orange)" }}>Rs. {nextEntry.costPerDay?.toFixed(2)}k</b>
            &nbsp;·&nbsp; Cheapest remaining critical path option
          </div>
        </Card>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── Monte Carlo Simulation Tab ───────────────────────────────────────────────


function MonteCarloTab({ computed }) {
  const { nodes, projectEnd } = computed;
  const [iterations, setIterations] = useState(5000);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [targetDate, setTargetDate] = useState(Math.ceil(projectEnd));

  function run() {
    setRunning(true);
    setTimeout(() => {
      try {
        // Build tasks array from nodes for the engine
        const tasks = Object.values(nodes).map(n => ({
          id: n.id, predecessors: n.predecessors.join(","),
          o: n.o, m: n.m, p: n.p,
          normalCost: n.normalCost, crashCost: n.crashCost, crashTime: n.crashTime,
        }));
        const res = runMonteCarlo(tasks, iterations);
        setResult(res);
      } catch (e) {
        console.error(e);
      }
      setRunning(false);
    }, 50);
  }

  const HIST_W = 700, HIST_H = 220;

  return (
    <div className="fade-in">
      <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>Monte Carlo Simulation</div>
      <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 20 }}>Samples durations from PERT distributions to estimate project completion probability</div>

      {/* Controls */}
      <Card style={{ marginBottom: 24, display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6, letterSpacing: "0.06em" }}>ITERATIONS</div>
          <div style={{ display: "flex", gap: 8 }}>
            {[1000, 5000, 10000, 50000].map(n => (
              <button key={n} onClick={() => setIterations(n)} style={{
                background: iterations === n ? "var(--accent)" : "var(--bg2)",
                color: iterations === n ? "#000" : "var(--text2)",
                border: "1px solid var(--border2)", padding: "6px 14px", borderRadius: 5,
                cursor: "pointer", fontSize: 12, fontWeight: 700, transition: "all 0.15s",
                fontFamily: "'JetBrains Mono', monospace",
              }}>{n.toLocaleString()}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6, letterSpacing: "0.06em" }}>TARGET COMPLETION DATE</div>
          <input type="number" value={targetDate} onChange={e => setTargetDate(+e.target.value)}
            style={{
              background: "var(--bg2)", border: "1px solid var(--border2)", color: "var(--text)",
              padding: "7px 12px", borderRadius: 5, fontSize: 13, width: 100,
              fontFamily: "'JetBrains Mono', monospace",
            }} />
        </div>
        <button onClick={run} disabled={running} style={{
          background: running ? "var(--bg4)" : "var(--accent)", color: running ? "var(--text3)" : "#000",
          border: "none", padding: "10px 28px", borderRadius: 6, cursor: running ? "not-allowed" : "pointer",
          fontSize: 14, fontWeight: 800, transition: "all 0.15s",
          fontFamily: "'JetBrains Mono', monospace",
          animation: running ? "pulse 1s infinite" : "none",
        }}>
          {running ? "⏳ Running..." : "▶ Run Simulation"}
        </button>
      </Card>

      {!result && !running && (
        <Banner type="info">Click "Run Simulation" to sample {iterations.toLocaleString()} project schedules and compute completion probabilities.</Banner>
      )}

      {result && (
        <>
          {/* Key metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 24 }}>
            <MetricCard value={result.mean.toFixed(1)} label="MEAN DURATION" color="var(--accent)"
              tooltip="Average completion time across all simulations" />
            <MetricCard value={`±${result.std.toFixed(2)}`} label="STD DEVIATION" color="var(--blue)"
              tooltip="Spread of completion times" />
            <MetricCard value={result.p50.toFixed(1)} label="P50 (MEDIAN)" color="var(--text)"
              tooltip="50% chance of finishing by this date" />
            <MetricCard value={result.p80.toFixed(1)} label="P80" color="var(--orange)"
              tooltip="80% chance of finishing by this date — typical contract buffer" />
            <MetricCard value={result.p90.toFixed(1)} label="P90" color="var(--red)"
              tooltip="90% chance of finishing by this date — conservative estimate" />
          </div>

          {/* Probability for target date */}
          {(() => {
            const prob = result.results.filter(v => v <= targetDate).length / result.results.length * 100;
            const color = prob >= 80 ? "var(--accent)" : prob >= 50 ? "var(--orange)" : "var(--red)";
            return (
              <Banner type={prob >= 80 ? "success" : prob >= 50 ? "warn" : "error"}>
                <b>Probability of completing by Day {targetDate}: </b>
                <span style={{ fontSize: 18, fontWeight: 800, color }}>{prob.toFixed(1)}%</span>
                {" "}— {prob >= 90 ? "Very likely ✓" : prob >= 80 ? "Likely — good buffer" : prob >= 60 ? "Moderate risk — consider padding" : "High risk — needs schedule buffer"}
              </Banner>
            );
          })()}

          {/* Histogram */}
          <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 20, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14, color: "var(--text2)", letterSpacing: "0.06em" }}>
              COMPLETION TIME DISTRIBUTION ({iterations.toLocaleString()} iterations)
            </div>
            <div style={{ overflowX: "auto" }}>
              <svg width={HIST_W} height={HIST_H + 40} viewBox={`0 0 ${HIST_W} ${HIST_H + 40}`}>
                {(() => {
                  const maxCount = Math.max(...result.hist.map(b => b.count));
                  const binW = HIST_W / result.hist.length;
                  const p50x = ((result.p50 - result.min) / (result.max - result.min)) * HIST_W;
                  const p80x = ((result.p80 - result.min) / (result.max - result.min)) * HIST_W;
                  const p90x = ((result.p90 - result.min) / (result.max - result.min)) * HIST_W;
                  const targetX = ((targetDate - result.min) / (result.max - result.min)) * HIST_W;
                  const detBx = ((projectEnd - result.min) / (result.max - result.min)) * HIST_W;

                  return (
                    <>
                      {/* Bars */}
                      {result.hist.map((bin, i) => {
                        const h = (bin.count / maxCount) * HIST_H;
                        const x = i * binW;
                        const isBeforeTarget = bin.x + (result.max - result.min) / result.hist.length <= targetDate;
                        return (
                          <rect key={i} x={x + 1} y={HIST_H - h} width={binW - 2} height={h}
                            fill={isBeforeTarget ? "var(--accent)" : "var(--border2)"}
                            opacity={0.8} rx={1} />
                        );
                      })}

                      {/* Deterministic duration line */}
                      {detBx > 0 && detBx < HIST_W && (
                        <g>
                          <line x1={detBx} y1={0} x2={detBx} y2={HIST_H} stroke="var(--blue)" strokeWidth={2} strokeDasharray="6,3" />
                          <text x={detBx + 4} y={14} fontSize={10} fill="var(--blue)" fontFamily="JetBrains Mono,monospace">CPM: {projectEnd.toFixed(1)}</text>
                        </g>
                      )}
                      {/* P50 */}
                      <g>
                        <line x1={p50x} y1={0} x2={p50x} y2={HIST_H} stroke="var(--text2)" strokeWidth={1.5} strokeDasharray="4,3" />
                        <text x={p50x + 3} y={28} fontSize={9} fill="var(--text2)" fontFamily="JetBrains Mono,monospace">P50</text>
                      </g>
                      {/* P80 */}
                      <g>
                        <line x1={p80x} y1={0} x2={p80x} y2={HIST_H} stroke="var(--orange)" strokeWidth={1.5} strokeDasharray="4,3" />
                        <text x={p80x + 3} y={42} fontSize={9} fill="var(--orange)" fontFamily="JetBrains Mono,monospace">P80</text>
                      </g>
                      {/* P90 */}
                      <g>
                        <line x1={p90x} y1={0} x2={p90x} y2={HIST_H} stroke="var(--red)" strokeWidth={1.5} strokeDasharray="4,3" />
                        <text x={p90x + 3} y={56} fontSize={9} fill="var(--red)" fontFamily="JetBrains Mono,monospace">P90</text>
                      </g>
                      {/* Target */}
                      {targetX > 0 && targetX < HIST_W && (
                        <g>
                          <line x1={targetX} y1={0} x2={targetX} y2={HIST_H} stroke="#fff" strokeWidth={2} strokeDasharray="8,3" opacity={0.5} />
                          <text x={targetX + 3} y={70} fontSize={9} fill="#fff" opacity={0.5} fontFamily="JetBrains Mono,monospace">Target</text>
                        </g>
                      )}
                      {/* X axis labels */}
                      {[0, 0.25, 0.5, 0.75, 1].map(t => {
                        const val = result.min + t * (result.max - result.min);
                        return (
                          <text key={t} x={t * HIST_W} y={HIST_H + 16} textAnchor="middle"
                            fontSize={10} fill="var(--text3)" fontFamily="JetBrains Mono,monospace">
                            {val.toFixed(1)}
                          </text>
                        );
                      })}
                      <text x={HIST_W / 2} y={HIST_H + 34} textAnchor="middle" fontSize={10} fill="var(--text3)" fontFamily="JetBrains Mono,monospace">
                        Project Duration (Days)
                      </text>
                    </>
                  );
                })()}
              </svg>
            </div>
          </div>

          {/* Percentile table */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 10 }}>
            {[
              { p: "P10", v: result.p10, color: "var(--accent)" },
              { p: "P50", v: result.p50, color: "var(--text)" },
              { p: "P80", v: result.p80, color: "var(--orange)" },
              { p: "P90", v: result.p90, color: "var(--red)" },
              { p: "MIN", v: result.min, color: "var(--text2)" },
              { p: "MAX", v: result.max, color: "var(--text2)" },
            ].map(({ p, v, color }) => (
              <div key={p} style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 7, padding: "12px 14px", textAlign: "center" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color }}>{v.toFixed(1)}</div>
                <div style={{ fontSize: 10, opacity: 0.4, marginTop: 4 }}>{p}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── EVM Tab ──────────────────────────────────────────────────────────────────


function fmt(n, prefix = "", suffix = "") { return `${prefix}${Math.abs(n).toFixed(2)}${suffix}`; }
function sign(n) { return n >= 0 ? "+" : "−"; }

function EVMTab({ computed }) {
  const { projectEnd, nodes } = computed;
  const totalBudget = Object.values(nodes).reduce((s, n) => s + n.normalCost, 0);

  const [bac, setBac]   = useState(totalBudget);
  const [pct, setPct]   = useState(30);
  const [ac,  setAc]    = useState(Math.round(totalBudget * 0.35));
  const [day, setDay]   = useState(Math.round(projectEnd * 0.5));
  const [gain, setGain] = useState(400);
  const [gainP, setGainP] = useState(60);
  const [loss, setLoss] = useState(100);

  // Core EVM
  const PV  = bac * (day / projectEnd);           // Planned Value
  const EV  = bac * (pct / 100);                  // Earned Value
  const CV  = EV - ac;                            // Cost Variance
  const SV  = EV - PV;                            // Schedule Variance
  const CPI = ac !== 0 ? EV / ac : 0;             // Cost Performance Index
  const SPI = PV !== 0 ? EV / PV : 0;             // Schedule Performance Index

  // EAC variants
  const EAC1 = bac / CPI;                         // EAC based on CPI
  const EAC2 = ac + (bac - EV);                   // EAC assuming remaining on budget
  const EAC3 = ac + (bac - EV) / CPI;             // EAC using CPI for remaining
  const EACmax = Math.max(EAC1, EAC2, EAC3);

  const ETC  = EACmax - ac;
  const TCPI = (bac - EV) / (bac - ac);           // To Complete Performance Index
  const VAC  = bac - EACmax;                       // Variance at Completion

  // EMV
  const EMV = (gain * gainP / 100) - (loss * (100 - gainP) / 100);
  const lossP = 100 - gainP;

  const statusColor = (v) => v >= 0 ? "var(--accent)" : "var(--red)";
  const indexColor  = (v) => v >= 1 ? "var(--accent)" : v >= 0.8 ? "var(--orange)" : "var(--red)";

  const inputStyle = {
    background: "var(--bg2)", border: "1px solid var(--border2)", color: "var(--text)",
    padding: "8px 12px", borderRadius: 5, fontSize: 13, width: "100%",
    fontFamily: "'JetBrains Mono', monospace",
  };

  return (
    <div className="fade-in">
      <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>Earned Value Management</div>
      <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 20 }}>CV · SV · CPI · SPI · EAC · ETC · TCPI · VAC · EMV</div>

      {/* Input controls */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 24 }}>
        <Card>
          <div style={{ fontSize: 11, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 12 }}>PROJECT PARAMETERS</div>
          {[
            { label: "Budget at Completion (BAC)", val: bac, set: setBac, hint: "Total planned budget (Rs. 000)" },
            { label: "Project Duration (days)", val: projectEnd.toFixed(1), set: null, hint: "From CPM calculation — fixed" },
            { label: "Current Day", val: day, set: setDay, hint: "Status date (day number)" },
          ].map(({ label, val, set, hint }) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>{label}</div>
              <input style={{ ...inputStyle, background: set ? "var(--bg2)" : "var(--bg4)", cursor: set ? "text" : "not-allowed" }}
                value={val} readOnly={!set} onChange={set ? e => set(+e.target.value) : undefined} />
              <div style={{ fontSize: 9, color: "var(--text3)", marginTop: 2, opacity: 0.6 }}>{hint}</div>
            </div>
          ))}
        </Card>

        <Card>
          <div style={{ fontSize: 11, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 12 }}>PROGRESS STATUS</div>
          {[
            { label: "% Complete", val: pct, set: setPct, suffix: "%", hint: "Work physically completed" },
            { label: "Actual Cost (AC)", val: ac, set: setAc, hint: "Total cost incurred so far (Rs. 000)" },
          ].map(({ label, val, set, hint }) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>{label}</div>
              <input style={inputStyle} type="number" value={val} onChange={e => set(+e.target.value)} />
              <div style={{ fontSize: 9, color: "var(--text3)", marginTop: 2, opacity: 0.6 }}>{hint}</div>
            </div>
          ))}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 6 }}>% Complete Slider</div>
            <input type="range" min={0} max={100} value={pct} onChange={e => setPct(+e.target.value)}
              style={{ width: "100%", accentColor: "var(--accent)" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--text3)", marginTop: 2 }}>
              <span>0%</span><span style={{ color: "var(--accent)", fontWeight: 700 }}>{pct}%</span><span>100%</span>
            </div>
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 11, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 12 }}>EMV — RISK SCENARIOS</div>
          {[
            { label: "Gain Amount (Rs. 000)", val: gain, set: setGain },
            { label: "Gain Probability (%)", val: gainP, set: setGainP },
            { label: "Loss Amount (Rs. 000)", val: loss, set: setLoss },
          ].map(({ label, val, set }) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>{label}</div>
              <input style={inputStyle} type="number" value={val} onChange={e => set(+e.target.value)} />
            </div>
          ))}
          <div style={{ fontSize: 9, color: "var(--text3)", opacity: 0.6 }}>
            Loss probability = {lossP}% (complement of gain probability)
          </div>
        </Card>
      </div>

      {/* Computed intermediate values */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "PLANNED VALUE (PV)", val: PV.toFixed(2), color: "var(--blue)", tip: "Budgeted work scheduled to be done by now" },
          { label: "EARNED VALUE (EV)", val: EV.toFixed(2), color: "var(--accent)", tip: "Budgeted value of work actually completed" },
          { label: "ACTUAL COST (AC)", val: ac.toFixed(2), color: "var(--orange)", tip: "Total cost actually spent so far" },
        ].map(m => (
          <div key={m.label} className="tooltip" style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 18px" }}>
            <span className="tip">{m.tip}</span>
            <div style={{ fontSize: 22, fontWeight: 800, color: m.color }}>{m.val}</div>
            <div style={{ fontSize: 10, opacity: 0.4, marginTop: 4, letterSpacing: "0.08em" }}>{m.label} (Rs. 000)</div>
          </div>
        ))}
      </div>

      {/* Variances & Indices */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
        <MetricCard value={`${sign(CV)} ${fmt(CV)}`} label="COST VARIANCE (CV)" color={statusColor(CV)}
          tooltip={`EV − AC = ${EV.toFixed(2)} − ${ac.toFixed(2)}. ${CV >= 0 ? "Under budget ✓" : "Over budget ✗"}`} />
        <MetricCard value={`${sign(SV)} ${fmt(SV)}`} label="SCHEDULE VARIANCE (SV)" color={statusColor(SV)}
          tooltip={`EV − PV = ${EV.toFixed(2)} − ${PV.toFixed(2)}. ${SV >= 0 ? "Ahead of schedule ✓" : "Behind schedule ✗"}`} />
        <MetricCard value={CPI.toFixed(3)} label="COST PERF INDEX (CPI)" color={indexColor(CPI)}
          tooltip={`EV/AC. ${CPI >= 1 ? "Getting more than Rs.1 of value per Rs.1 spent ✓" : "Overspending per unit of work ✗"}`} />
        <MetricCard value={SPI.toFixed(3)} label="SCHEDULE PERF INDEX (SPI)" color={indexColor(SPI)}
          tooltip={`EV/PV. ${SPI >= 1 ? "Completing more work than planned ✓" : "Behind planned progress ✗"}`} />
      </div>

      {/* EAC / ETC / TCPI */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
        <MetricCard value={EAC1.toFixed(2)} label="EAC (÷ CPI)" color="var(--red)"
          tooltip="BAC/CPI — assumes future performance matches current CPI (pessimistic if CPI<1)" />
        <MetricCard value={EAC2.toFixed(2)} label="EAC (remaining on plan)" color="var(--orange)"
          tooltip="AC + (BAC−EV) — assumes remaining work done at original budget" />
        <MetricCard value={EAC3.toFixed(2)} label="EAC (CPI for remaining)" color="var(--orange)"
          tooltip="AC + (BAC−EV)/CPI — weighted estimate" />
        <MetricCard value={EACmax.toFixed(2)} label="EAC MAX (HIGHEST)" color="var(--red)"
          tooltip="Most conservative — use this for worst-case planning" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 24 }}>
        <MetricCard value={ETC.toFixed(2)} label="ETC — ESTIMATE TO COMPLETE" color="var(--orange)"
          tooltip="EAC_max − AC: additional funds needed from today" />
        <MetricCard value={TCPI.toFixed(3)} label="TCPI — TO COMPLETE PERF INDEX" color={indexColor(TCPI)}
          tooltip={`(BAC−EV)/(BAC−AC). Need CPI of ${TCPI.toFixed(2)} for remaining work to finish on budget.${TCPI > 1.2 ? " ⚠ Unrealistic." : ""}`} />
        <MetricCard value={`${sign(VAC)} ${fmt(VAC)}`} label="VAC — VARIANCE AT COMPLETION" color={statusColor(VAC)}
          tooltip={`BAC − EAC_max. ${VAC >= 0 ? "Expected to finish under budget ✓" : "Expected cost overrun ✗"}`} />
      </div>

      {/* Interpretation */}
      <Banner type={CV >= 0 && SV >= 0 ? "success" : CV < 0 && SV < 0 ? "error" : "warn"}>
        <b>Interpretation: </b>
        The project is <b style={{ color: statusColor(SV) }}>{SV >= 0 ? "ahead of" : "behind"} schedule</b> (SV = {sign(SV)}{fmt(SV)}) and{" "}
        <b style={{ color: statusColor(CV) }}>{CV >= 0 ? "under" : "over"} budget</b> (CV = {sign(CV)}{fmt(CV)}).{" "}
        For every Rs.1 spent, the project delivers Rs.{CPI.toFixed(2)} of value (CPI).{" "}
        At this rate, the project is forecast to cost Rs.{EACmax.toFixed(0)}k total — a{" "}
        <b style={{ color: statusColor(VAC) }}>{VAC >= 0 ? "saving" : "overrun"} of Rs.{fmt(VAC)}k</b>.
      </Banner>

      {/* EMV Section */}
      <div style={{ fontFamily: "'Syne'", fontSize: 18, fontWeight: 700, margin: "24px 0 12px" }}>Expected Monetary Value (EMV)</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12, letterSpacing: "0.06em" }}>SCENARIO BREAKDOWN</div>
          <div style={{ marginBottom: 10, padding: "12px 14px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 7 }}>
            <div style={{ fontSize: 13, color: "var(--accent)", marginBottom: 4 }}>
              Gain: Rs.{gain}k × {gainP}% = <b>+Rs.{(gain * gainP / 100).toFixed(1)}k</b>
            </div>
            <div style={{ fontSize: 13, color: "var(--red)" }}>
              Loss: Rs.{loss}k × {lossP}% = <b>−Rs.{(loss * lossP / 100).toFixed(1)}k</b>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
            EMV = (+{gain}k × {gainP}%) + (−{loss}k × {lossP}%) = <b style={{ color: EMV >= 0 ? "var(--accent)" : "var(--red)", fontSize: 13 }}>
              {EMV >= 0 ? "+" : "−"}Rs.{Math.abs(EMV).toFixed(1)}k
            </b>
          </div>
        </Card>
        <div>
          <MetricCard value={`${EMV >= 0 ? "+" : "−"}Rs.${Math.abs(EMV).toFixed(1)}k`}
            label="EXPECTED MONETARY VALUE" color={EMV >= 0 ? "var(--accent)" : "var(--red)"}
            tooltip="Probability-weighted expected financial outcome" />
          <Banner type={EMV >= 0 ? "success" : "error"} >
            {EMV >= 0
              ? `✓ Positive EMV of Rs.${EMV.toFixed(1)}k — the project is financially justified on expected value grounds.`
              : `✗ Negative EMV of −Rs.${Math.abs(EMV).toFixed(1)}k — risk-adjusted returns are unfavourable. Review risk mitigation.`}
          </Banner>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── Resource Histogram Tab ───────────────────────────────────────────────────

function ResourceTab({ computed }) {
  const { nodes, ES, EF, projectEnd } = computed;

  // Gather resources
  const resources = {};
  Object.values(nodes).forEach(n => {
    const r = n.resource || "Unassigned";
    if (!resources[r]) resources[r] = [];
    resources[r].push({ id: n.id, es: ES[n.id], ef: EF[n.id], duration: n.duration });
  });

  // Build daily load per resource
  const days = Math.ceil(projectEnd) + 1;
  const COLORS = ["var(--accent)", "var(--blue)", "var(--orange)", "var(--red)", "#a78bfa", "#f472b6", "#34d399"];

  const resourceList = Object.keys(resources);
  const loads = {};
  resourceList.forEach(r => {
    loads[r] = Array(days).fill(0);
    resources[r].forEach(t => {
      for (let d = Math.floor(t.es); d < Math.ceil(t.ef); d++) {
        if (d < days) loads[r][d]++;
      }
    });
  });

  const BAR_W = 14, CHART_H = 120, GAP = 2;
  const maxLoad = Math.max(...Object.values(loads).flatMap(l => l));

  return (
    <div className="fade-in">
      <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>Resource Histogram</div>
      <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 20 }}>Daily resource utilisation based on early-start schedule · Assign resources in the Input tab</div>

      {resourceList.length === 0 || (resourceList.length === 1 && resourceList[0] === "Unassigned") ? (
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 40, textAlign: "center", color: "var(--text3)" }}>
          Add resource names in the "Resource" column of the Input tab to see utilisation charts.
        </div>
      ) : (
        <>
          {/* Task-Resource assignment table */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 12, marginBottom: 24 }}>
            {resourceList.map((r, ri) => (
              <div key={r} style={{ background: "var(--bg2)", border: `1px solid ${COLORS[ri % COLORS.length]}44`, borderRadius: 8, padding: "12px 16px" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: COLORS[ri % COLORS.length], marginBottom: 8 }}>{r}</div>
                {resources[r].map(t => (
                  <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text2)", marginBottom: 3 }}>
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>{t.id}</span>
                    <span>Day {t.es.toFixed(1)} → {t.ef.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Histograms */}
          {resourceList.map((r, ri) => {
            const load = loads[r];
            const color = COLORS[ri % COLORS.length];
            const maxR = Math.max(...load, 1);
            const totalDays = load.filter(v => v > 0).length;
            const peakDays = load.filter(v => v > 1).length;

            return (
              <div key={r} style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color }}>{r}</div>
                  <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--text3)" }}>
                    <span>Active days: <b style={{ color }}>{totalDays}</b></span>
                    <span>Overloaded days: <b style={{ color: peakDays > 0 ? "var(--red)" : "var(--accent)" }}>{peakDays}</b></span>
                  </div>
                </div>
                <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 8, padding: "16px 12px", overflowX: "auto" }}>
                  <svg height={CHART_H + 30} width={Math.max(600, days * (BAR_W + GAP) + 40)}>
                    {/* Y axis labels */}
                    {Array.from({ length: maxR + 1 }, (_, i) => (
                      <text key={i} x={20} y={CHART_H - (i / maxR) * CHART_H + 4}
                        textAnchor="end" fontSize={9} fill="var(--text3)" fontFamily="JetBrains Mono,monospace">{i}</text>
                    ))}
                    {/* Overload line at 1 */}
                    <line x1={28} y1={CHART_H - (1 / maxR) * CHART_H} x2={days * (BAR_W + GAP) + 28} y2={CHART_H - (1 / maxR) * CHART_H}
                      stroke="var(--red)" strokeWidth={1} strokeDasharray="4,3" opacity={0.5} />

                    {load.map((v, d) => {
                      const h = v > 0 ? Math.max(3, (v / maxR) * CHART_H) : 0;
                      const x = 30 + d * (BAR_W + GAP);
                      const isOver = v > 1;
                      return (
                        <g key={d}>
                          <rect x={x} y={CHART_H - h} width={BAR_W} height={h}
                            fill={isOver ? "var(--red)" : color} opacity={0.85} rx={2} />
                          {/* Day label every 5 */}
                          {d % 5 === 0 && (
                            <text x={x + BAR_W / 2} y={CHART_H + 16} textAnchor="middle"
                              fontSize={8} fill="var(--text3)" fontFamily="JetBrains Mono,monospace">{d}</text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                  <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>
                    <span style={{ color: "var(--red)" }}>■</span> Overloaded (>1 concurrent task) &nbsp;
                    <span style={{ color }}>■</span> Normal utilisation
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ─── CPM / PERT Pro — Main App ────────────────────────────────────────────────


// Two-level tab groups
const TAB_GROUPS = [
  {
    group: "Basic",
    color: "var(--accent)",
    tabs: [
      { id: "input",   label: "Input",         icon: "⌨" },
      { id: "pert",    label: "PERT Estimates", icon: "∑" },
      { id: "network", label: "Network Graph",  icon: "◎" },
      { id: "cpm",     label: "CPM Analysis",   icon: "⧖" },
      { id: "crash",   label: "Crash Analysis", icon: "⚡" },
    ],
  },
  {
    group: "Advanced",
    color: "var(--blue)",
    tabs: [
      { id: "gantt",    label: "Gantt Chart",     icon: "▬" },
      { id: "monte",    label: "Monte Carlo",     icon: "◈" },
      { id: "evm",      label: "EVM / EMV",       icon: "₹" },
      { id: "resource", label: "Resources",       icon: "◉" },
    ],
  },
];
const ALL_TABS = TAB_GROUPS.flatMap(g => g.tabs);

function loadFromStorage() {
  try {
    const saved = localStorage.getItem("cpm_pro_data");
    if (saved) return JSON.parse(saved);
  } catch {}
  return null;
}

function saveToStorage(tasks, scenarios) {
  try { localStorage.setItem("cpm_pro_data", JSON.stringify({ tasks, scenarios })); } catch {}
}

function App() {
  const saved = loadFromStorage();
  const [tasks, setTasksRaw] = useState(saved?.tasks || DEFAULT_TASKS);
  const [scenarios, setScenarios] = useState(saved?.scenarios || []);
  const [activeTab, setActiveTab] = useState("input");
  const [computed, setComputed] = useState(null);
  const [validationErrors, setValidationErrors] = useState([]);
  const [computeError, setComputeError] = useState("");
  const [generated, setGenerated] = useState(false);
  const [theme, setTheme] = useState("dark");
  const [showScenarios, setShowScenarios] = useState(false);
  const [scenarioName, setScenarioName] = useState("");

  const T = theme === "dark" ? DARK : LIGHT;

  // Inject CSS variables whenever theme changes
  useEffect(() => {
    const root = document.documentElement;
    Object.entries(T).forEach(([k, v]) => {
      if (typeof v === "string") root.style.setProperty(`--${k}`, v);
    });
  }, [theme, T]);

  function setTasks(fn) {
    setTasksRaw(prev => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      saveToStorage(next, scenarios);
      setGenerated(false);
      return next;
    });
  }

  function handleGenerate() {
    const errors = validateTasks(tasks);
    setValidationErrors(errors);
    const blockers = errors.filter(e => e.type === "invalid" || e.type === "duplicate");
    if (blockers.length > 0) {
      setComputeError("");
      setComputed(null);
      setGenerated(false);
      return;
    }
    try {
      const result = computeFullCPM(tasks);
      setComputed(result);
      setComputeError("");
      setGenerated(true);
    } catch (e) {
      setComputeError(e.message);
      setComputed(null);
      setGenerated(false);
    }
  }

  function saveScenario() {
    const name = scenarioName.trim() || `Scenario ${scenarios.length + 1}`;
    const newScenarios = [...scenarios, { name, tasks: JSON.parse(JSON.stringify(tasks)), savedAt: new Date().toLocaleString() }];
    setScenarios(newScenarios);
    saveToStorage(tasks, newScenarios);
    setScenarioName("");
  }

  function loadScenario(s) {
    setTasksRaw(s.tasks);
    setGenerated(false);
    setComputed(null);
    setShowScenarios(false);
  }

  function deleteScenario(i) {
    const next = scenarios.filter((_, idx) => idx !== i);
    setScenarios(next);
    saveToStorage(tasks, next);
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify({ tasks, computed: computed ? { projectEnd: computed.projectEnd, criticalPath: computed.criticalPath } : null }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cpm_project.json"; a.click();
  }

  function importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.tasks) { setTasksRaw(data.tasks); setGenerated(false); setComputed(null); }
      } catch { alert("Invalid JSON file"); }
    };
    reader.readAsText(file);
  }

  function exportCSV() {
    if (!computed) return;
    const { nodes, ES, EF, LS, LF, slack, criticalPath } = computed;
    const rows = [["Task","Duration","ES","EF","LS","LF","Slack","Critical"]];
    Object.keys(nodes).forEach(id => {
      rows.push([id, nodes[id].duration.toFixed(2), ES[id].toFixed(2), EF[id].toFixed(2),
        LS[id].toFixed(2), LF[id].toFixed(2), slack[id].toFixed(2), criticalPath.includes(id) ? "Yes" : "No"]);
    });
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cpm_results.csv"; a.click();
  }

  function printReport() {
    window.print();
  }

  const tabUnlocked = (id) => id === "input" || generated;
  // eslint-disable-next-line no-unused-vars
  const _allTabs = ALL_TABS; // keep reference

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace", background: "var(--bg)", minHeight: "100vh", color: "var(--text)", fontSize: 13 }}>
      <style>{makeGlobalCSS(T)}</style>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; color: black; }
        }
      `}</style>

      {/* ── Header ── */}
      <div className="no-print" style={{
        background: "var(--bg2)", borderBottom: "1px solid var(--border)",
        padding: "0 32px", display: "flex", alignItems: "center", gap: 0, height: 54,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 32 }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 12px var(--accentGlow)" }} />
          <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text)" }}>
            CPM<span style={{ color: "var(--accent)" }}>pro</span>
          </span>
        </div>

        {/* Grouped Tabs */}
        <div style={{ display: "flex", flex: 1, height: "100%", overflowX: "auto", alignItems: "stretch" }}>
          {TAB_GROUPS.map((group, gi) => (
            <div key={group.group} style={{
              display: "flex", alignItems: "stretch",
              borderRight: gi < TAB_GROUPS.length - 1 ? "1px solid var(--border)" : "none",
              marginRight: gi < TAB_GROUPS.length - 1 ? 0 : 0,
            }}>
              {/* Group label */}
              <div style={{
                display: "flex", alignItems: "center", padding: "0 10px 0 14px",
                fontSize: 9, fontWeight: 800, letterSpacing: "0.15em",
                color: group.color, opacity: 0.5, whiteSpace: "nowrap",
                borderRight: "1px solid var(--border)", marginRight: 2,
                textTransform: "uppercase",
              }}>{group.group}</div>
              {/* Tabs in group */}
              {group.tabs.map(tab => {
                const unlocked = tabUnlocked(tab.id);
                const active = activeTab === tab.id;
                return (
                  <button key={tab.id} className="tab-btn"
                    onClick={() => unlocked && setActiveTab(tab.id)}
                    style={{
                      background: active ? `${group.color}11` : "none",
                      border: "none", cursor: unlocked ? "pointer" : "not-allowed",
                      padding: "0 14px", height: "100%", fontSize: 12, letterSpacing: "0.02em",
                      color: active ? group.color : unlocked ? "var(--text2)" : "var(--text3)",
                      borderBottom: active ? `2px solid ${group.color}` : "2px solid transparent",
                      opacity: unlocked ? 1 : 0.3, transition: "all 0.15s", whiteSpace: "nowrap",
                      display: "flex", alignItems: "center", gap: 5,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}>
                    <span style={{ fontSize: 10, opacity: 0.7 }}>{tab.icon}</span>
                    {tab.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Right actions */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: 16, flexShrink: 0 }}>
          {/* Scenario manager */}
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowScenarios(v => !v)} style={{
              background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text2)",
              padding: "6px 12px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600,
              fontFamily: "'JetBrains Mono', monospace",
            }}>📁 Scenarios {scenarios.length > 0 && `(${scenarios.length})`}</button>
            {showScenarios && (
              <div style={{
                position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 200,
                background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 8,
                minWidth: 280, boxShadow: "0 8px 32px #0008", padding: 12,
              }}>
                <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10, fontWeight: 700, letterSpacing: "0.07em" }}>SAVE / LOAD SCENARIOS</div>
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  <input value={scenarioName} onChange={e => setScenarioName(e.target.value)}
                    placeholder="Scenario name..." style={{
                      flex: 1, background: "var(--bg3)", border: "1px solid var(--border2)",
                      color: "var(--text)", padding: "6px 9px", borderRadius: 4, fontSize: 12,
                      fontFamily: "'JetBrains Mono', monospace",
                    }} />
                  <button onClick={saveScenario} style={{
                    background: "var(--accent)", color: "#000", border: "none",
                    padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>Save</button>
                </div>
                {scenarios.length === 0 && <div style={{ fontSize: 11, color: "var(--text3)", padding: "6px 0" }}>No saved scenarios yet.</div>}
                {scenarios.map((s, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "7px 8px", borderRadius: 5, marginBottom: 4,
                    background: "var(--bg3)", border: "1px solid var(--border)",
                  }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</div>
                      <div style={{ fontSize: 10, color: "var(--text3)" }}>{s.savedAt} · {s.tasks.length} tasks</div>
                    </div>
                    <div style={{ display: "flex", gap: 5 }}>
                      <button onClick={() => loadScenario(s)} style={{
                        background: "var(--accent)", color: "#000", border: "none",
                        padding: "3px 8px", borderRadius: 3, cursor: "pointer", fontSize: 10, fontWeight: 700,
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>Load</button>
                      <button onClick={() => deleteScenario(i)} style={{
                        background: "transparent", border: "1px solid var(--border)", color: "var(--red)",
                        padding: "3px 7px", borderRadius: 3, cursor: "pointer", fontSize: 10,
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Export menu */}
          <button onClick={exportJSON} style={{
            background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text2)",
            padding: "6px 11px", borderRadius: 5, cursor: "pointer", fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
          }}>↓ JSON</button>
          <label style={{
            background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text2)",
            padding: "6px 11px", borderRadius: 5, cursor: "pointer", fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            ↑ Import
            <input type="file" accept=".json" onChange={importJSON} style={{ display: "none" }} />
          </label>
          {computed && <button onClick={exportCSV} style={{
            background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text2)",
            padding: "6px 11px", borderRadius: 5, cursor: "pointer", fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
          }}>↓ CSV</button>}
          <button onClick={printReport} style={{
            background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text2)",
            padding: "6px 11px", borderRadius: 5, cursor: "pointer", fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
          }}>⎙ Print</button>

          {/* Theme toggle */}
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} style={{
            background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text2)",
            width: 32, height: 32, borderRadius: 5, cursor: "pointer", fontSize: 15,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>{theme === "dark" ? "☀" : "☾"}</button>
        </div>
      </div>

      {/* ── Status bar ── */}
      {generated && computed && (
        <div className="no-print" style={{
          background: "var(--bg2)", borderBottom: "1px solid var(--border)",
          padding: "6px 32px", display: "flex", gap: 28, fontSize: 11, color: "var(--text3)",
          overflowX: "auto",
        }}>
          <span>Tasks: <b style={{ color: "var(--text)" }}>{tasks.length}</b></span>
          <span>Duration: <b style={{ color: "var(--accent)" }}>{computed.projectEnd.toFixed(1)} days</b></span>
          <span>Critical: <b style={{ color: "var(--red)" }}>{computed.criticalPath.join("→")}</b></span>
          <span>Near-critical: <b style={{ color: "var(--orange)" }}>{Object.values(computed.slack).filter(s=>s>0&&s<=2).length}</b></span>
          <span>Total cost: <b style={{ color: "var(--text)" }}>Rs. {Object.values(computed.nodes).reduce((s,n)=>s+n.normalCost,0).toLocaleString()}k</b></span>
          <span style={{ marginLeft: "auto", color: "var(--accent)" }}>✓ Generated</span>
        </div>
      )}

      {/* ── Content ── */}
      <div style={{ padding: "28px 32px", maxWidth: "100%" }}>
        {computeError && (
          <div style={{ background: "var(--critBg)", border: "1px solid var(--red)", borderRadius: 6, padding: "10px 16px", marginBottom: 16, color: "#ff9999", fontSize: 12 }}>
            <b>✕ Computation error: </b>{computeError}
          </div>
        )}

        {activeTab === "input" && (
          <InputTab tasks={tasks} setTasks={setTasks} onGenerate={handleGenerate}
            validationErrors={validationErrors} generated={generated} />
        )}
        {activeTab === "pert"     && computed && <PERTTab computed={computed} />}
        {activeTab === "network"  && computed && <NetworkGraph computed={computed} />}
        {activeTab === "gantt"    && computed && <GanttChart computed={computed} />}
        {activeTab === "cpm"      && computed && <CPMAnalysis computed={computed} />}
        {activeTab === "crash"    && computed && <CrashAnalysis computed={computed} />}
        {activeTab === "monte"    && computed && <MonteCarloTab computed={computed} />}
        {activeTab === "evm"      && computed && <EVMTab computed={computed} />}
        {activeTab === "resource" && computed && <ResourceTab computed={computed} />}

        {!generated && activeTab !== "input" && (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text3)" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚡</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>No data generated yet</div>
            <div style={{ fontSize: 12 }}>Go to the Input tab and press Generate</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PERT Tab (inline since it's small) ──────────────────────────────────────
function PERTTab({ computed }) {
  const { nodes } = computed;
  return (
    <div className="fade-in">
      <div style={{ fontFamily: "'Syne'", fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>PERT Estimates</div>
      <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 20 }}>Expected = (O + 4M + P) / 6 · σ = (P − O) / 6</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>{["Task","O","M","P","Expected Duration","Std Dev σ","Variance σ²","95% Range"].map(h=>(
              <th key={h} style={{ background:"var(--bg2)", color:"var(--accent)", padding:"10px 14px", textAlign:"left", borderBottom:"1px solid var(--border)", fontWeight:700, fontSize:10, letterSpacing:"0.07em", whiteSpace:"nowrap" }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {Object.keys(nodes).map(id => {
              const n = nodes[id]; const sd = n.sigma;
              return (
                <tr key={id}>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)", color:"var(--accent)", fontWeight:800, fontSize:14 }}>{id}</td>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)" }}>{n.o}</td>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)" }}>{n.m}</td>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)" }}>{n.p}</td>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)", fontWeight:700, fontSize:14 }}>{n.duration.toFixed(2)}</td>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)", color:"var(--blue)" }}>{sd.toFixed(3)}</td>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)", color:"var(--text2)" }}>{(sd*sd).toFixed(4)}</td>
                  <td style={{ padding:"9px 14px", borderBottom:"1px solid var(--border)", color:"var(--text3)", fontSize:11 }}>
                    {(n.duration - 2*sd).toFixed(1)} – {(n.duration + 2*sd).toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


export default App;
