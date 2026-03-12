import { useState } from "react";

const DEFAULT_TASKS = [
  { id: "A", predecessors: "", o: 2, m: 4, p: 12, normalCost: 250, crashCost: 350, crashTime: 5 },
  { id: "B", predecessors: "", o: 4, m: 6, p: 14, normalCost: 400, crashCost: 600, crashTime: 6 },
  { id: "C", predecessors: "A", o: 6, m: 9, p: 18, normalCost: 500, crashCost: 650, crashTime: 8 },
  { id: "D", predecessors: "A,B", o: 9, m: 10, p: 11, normalCost: 500, crashCost: 600, crashTime: 9 },
  { id: "E", predecessors: "B", o: 6, m: 15, p: 18, normalCost: 700, crashCost: 800, crashTime: 13 },
  { id: "F", predecessors: "C,D", o: 17, m: 26, p: 29, normalCost: 800, crashCost: 900, crashTime: 23 },
  { id: "G", predecessors: "C,D,E", o: 7, m: 21, p: 29, normalCost: 750, crashCost: 950, crashTime: 19 },
  { id: "H", predecessors: "F,G", o: 16, m: 18, p: 20, normalCost: 650, crashCost: 800, crashTime: 15 },
];

const INT_FIELDS = ["o", "m", "p", "normalCost", "crashCost", "crashTime"];

function isValidInt(val) {
  return /^-?\d+$/.test(String(val).trim());
}

function validateTasks(tasks) {
  const errors = [];
  // Integer fields
  tasks.forEach((t, i) => {
    INT_FIELDS.forEach(f => {
      if (!isValidInt(t[f])) errors.push({ row: i, field: f, type: "invalid" });
    });
  });
  // Duplicate IDs — flag second+ occurrence
  const seen = {};
  tasks.forEach((t, i) => {
    const id = String(t.id).trim();
    if (!id) {
      errors.push({ row: i, field: "id", type: "invalid" });
    } else if (seen[id] !== undefined) {
      errors.push({ row: i, field: "id", type: "duplicate" });
    } else {
      seen[id] = i;
    }
  });
  return errors;
}

// ─── CPM/PERT core ────────────────────────────────────────────────────────────

function computePERT(o, m, p) { return (o + 4 * m + p) / 6; }

function topoSort(nodes) {
  const visited = new Set(), result = [];
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    nodes[id].predecessors.forEach(p => visit(p));
    result.push(id);
  }
  Object.keys(nodes).forEach(id => visit(id));
  return result;
}

function buildGraph(tasks) {
  const nodes = {};
  tasks.forEach(t => {
    nodes[t.id] = {
      id: t.id,
      duration: parseFloat(computePERT(+t.o, +t.m, +t.p).toFixed(2)),
      predecessors: t.predecessors ? t.predecessors.split(",").map(s => s.trim()).filter(Boolean) : [],
      normalCost: +t.normalCost, crashCost: +t.crashCost, crashTime: +t.crashTime,
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
  const W = 1100, H = 440;
  const xStep = W / (maxLevel + 1);
  Object.keys(byLevel).forEach(lvl => {
    const items = byLevel[lvl];
    const yStep = H / (items.length + 1);
    items.forEach((id, i) => {
      positions[id] = { x: 80 + parseInt(lvl) * xStep, y: 50 + (i + 1) * yStep };
    });
  });
  return positions;
}

// ─── App ──────────────────────────────────────────────────────────────────────

const TABS = ["Input", "PERT Estimates", "Network Graph", "CPM Analysis", "Crash Analysis"];

export default function App() {
  const [tasks, setTasks] = useState(DEFAULT_TASKS);
  const [activeTab, setActiveTab] = useState(0);
  const [computed, setComputed] = useState(null);
  const [validationErrors, setValidationErrors] = useState([]);
  const [computeError, setComputeError] = useState("");
  const [crashDays, setCrashDays] = useState(4);
  const [generated, setGenerated] = useState(false);

  function handleGenerate() {
    const errors = validateTasks(tasks);
    setValidationErrors(errors);
    if (errors.length > 0) {
      setComputeError("");
      setComputed(null);
      setGenerated(false);
      return;
    }
    try {
      const nodes = buildGraph(tasks);
      const { ES, EF, order } = forwardPass(nodes);
      const { LS, LF, projectEnd } = backwardPass(nodes, ES, EF, order);
      const slack = computeSlack(ES, LS);
      const criticalPath = order.filter(id => Math.abs(slack[id]) < 0.001);
      const positions = layoutNodes(nodes);
      const allPaths = findAllPaths(nodes);
      const pathDurations = allPaths.map(path => ({
        path, duration: path.reduce((s, id) => s + nodes[id].duration, 0),
      })).sort((a, b) => b.duration - a.duration);
      setComputed({ nodes, ES, EF, LS, LF, slack, criticalPath, projectEnd, positions, pathDurations, order });
      setComputeError("");
      setGenerated(true);
    } catch (e) {
      setComputeError("Computation error: " + e.message);
      setComputed(null);
      setGenerated(false);
    }
  }

  function computeCrashPlan(targetDays) {
    if (!computed) return null;
    const { nodes } = computed;
    const crashLog = [];
    const crashed = {};
    Object.keys(nodes).forEach(id => { crashed[id] = 0; });
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
      if (critTasks.length === 0) { crashLog.push({ day: day + 1, note: "No more crashing possible" }); break; }
      const costPerDay = id => (nodes[id].crashCost - nodes[id].normalCost) / (nodes[id].duration - nodes[id].crashTime);
      const best = critTasks.reduce((a, b) => costPerDay(a) <= costPerDay(b) ? a : b);
      crashed[best] += 1;
      const cost = costPerDay(best);
      totalExtra += cost;
      crashLog.push({ day: day + 1, task: best, costPerDay: cost, cumCost: totalExtra });
    }
    return { crashLog, totalExtra };
  }

  const crashPlan = computed ? computeCrashPlan(crashDays) : null;
  const crashPlan1More = computed ? computeCrashPlan(crashDays + 1) : null;

  function updateTask(i, field, val) {
    setTasks(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t));
    // Clear that specific cell's error live as user edits
    setValidationErrors(prev => prev.filter(e => !(e.row === i && e.field === field)));
    setGenerated(false);
  }

  function addTask() {
    setTasks(prev => [...prev, {
      id: String.fromCharCode(65 + prev.length),
      predecessors: "", o: 1, m: 3, p: 5, normalCost: 100, crashCost: 150, crashTime: 2,
    }]);
    setGenerated(false);
  }

  function removeTask(i) {
    setTasks(prev => prev.filter((_, idx) => idx !== i));
    setValidationErrors(prev =>
      prev.filter(e => e.row !== i).map(e => ({ ...e, row: e.row > i ? e.row - 1 : e.row }))
    );
    setGenerated(false);
  }

  const invalidErrors = validationErrors.filter(e => e.type === "invalid");
  const duplicateErrors = validationErrors.filter(e => e.type === "duplicate");

  return (
    <div style={S.root}>
      <style>{globalCSS}</style>

      <div style={S.header}>
        <div style={S.headerDot} />
        <span style={S.headerTitle}>CPM / PERT <span style={{ color: "#4ade80" }}>Analyzer</span></span>
        <span style={S.headerSub}>CRITICAL PATH METHOD · PROJECT SCHEDULING TOOL</span>
      </div>

      <div style={S.tabBar}>
        {TABS.map((t, i) => (
          <button key={t}
            style={{
              ...S.tabBtn,
              ...(activeTab === i ? S.tabBtnActive : {}),
              ...(!generated && i > 0 ? { opacity: 0.3, cursor: "not-allowed" } : {}),
            }}
            onClick={() => { if (generated || i === 0) setActiveTab(i); }}
          >{t}</button>
        ))}
      </div>

      <div style={S.content}>
        {activeTab === 0 && (
          <InputTab
            tasks={tasks}
            updateTask={updateTask}
            addTask={addTask}
            removeTask={removeTask}
            onGenerate={handleGenerate}
            validationErrors={validationErrors}
            invalidErrors={invalidErrors}
            duplicateErrors={duplicateErrors}
            computeError={computeError}
            generated={generated}
          />
        )}
        {activeTab === 1 && computed && <PERTTab tasks={tasks} />}
        {activeTab === 2 && computed && <NetworkGraph computed={computed} />}
        {activeTab === 3 && computed && <CPMAnalysis computed={computed} />}
        {activeTab === 4 && computed && (
          <CrashAnalysis computed={computed} crashDays={crashDays} setCrashDays={setCrashDays}
            crashPlan={crashPlan} crashPlan1More={crashPlan1More} />
        )}
      </div>
    </div>
  );
}

// ─── Input Tab ────────────────────────────────────────────────────────────────

function InputTab({ tasks, updateTask, addTask, removeTask, onGenerate, validationErrors, invalidErrors, duplicateErrors, computeError, generated }) {
  const fields = ["id", "predecessors", "o", "m", "p", "normalCost", "crashCost", "crashTime"];
  const headers = ["Task ID", "Predecessors", "Optimistic (O)", "Most Likely (M)", "Pessimistic (P)", "Normal Cost", "Crash Cost", "Crash Time"];

  function getCellError(row, field) {
    return validationErrors.find(e => e.row === row && e.field === field) || null;
  }

  function getCellInputStyle(row, field) {
    const err = getCellError(row, field);
    if (!err) return S.input;
    if (err.type === "duplicate") return { ...S.input, border: "2px solid #ff3333", background: "#2a0808", color: "#ff9999" };
    if (err.type === "invalid")   return { ...S.input, border: "2px solid #f59e0b", background: "#1e1200", color: "#fbbf24" };
    return S.input;
  }

  return (
    <div>
      {/* Title + buttons */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20 }}>
        <div>
          <div style={S.sectionTitle}>Task Table</div>
          <div style={S.sectionSub}>Predecessors: comma-separated IDs (e.g. "A,B"). All numeric fields must be integers. Costs in Rs. (000).</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button style={S.btnSecondary} onClick={addTask}>+ Add Task</button>
          <button style={S.btnGenerate} onClick={onGenerate}>⚡ Generate</button>
        </div>
      </div>

      {/* Error / success banners */}
      {invalidErrors.length > 0 && (
        <div style={S.warnBox}>
          <span style={{ fontWeight: 700 }}>⚠ Invalid values — </span>
          {invalidErrors.length} cell{invalidErrors.length > 1 ? "s" : ""} highlighted in{" "}
          <span style={{ color: "#f59e0b", fontWeight: 700 }}>orange</span> contain non-integer values.
          Only whole numbers are allowed in numeric fields.
        </div>
      )}
      {duplicateErrors.length > 0 && (
        <div style={S.errBox}>
          <span style={{ fontWeight: 700 }}>✕ Duplicate Task ID — </span>
          {duplicateErrors.map((e, i) => (
            <span key={i}>
              Row {e.row + 1} (<span style={{ color: "#ff6666", fontWeight: 700 }}>"{tasks[e.row]?.id}"</span>){i < duplicateErrors.length - 1 ? ", " : ""}
            </span>
          ))}. Each Task ID must be unique.
        </div>
      )}
      {computeError && (
        <div style={S.errBox}><span style={{ fontWeight: 700 }}>✕ Error — </span>{computeError}</div>
      )}
      {generated && validationErrors.length === 0 && (
        <div style={S.successBox}>✓ Generated successfully — switch to any tab above to view results.</div>
      )}

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={S.table}>
          <thead>
            <tr>
              {headers.map(h => <th key={h} style={S.th}>{h}</th>)}
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "#0d1117" : "#0a0e15" }}>
                {fields.map(f => {
                  const err = getCellError(i, f);
                  return (
                    <td key={f} style={{ ...S.td, position: "relative", padding: "8px 10px" }}>
                      <input
                        style={getCellInputStyle(i, f)}
                        value={t[f]}
                        onChange={e => updateTask(i, f, e.target.value)}
                        title={
                          err?.type === "duplicate" ? "Duplicate Task ID — must be unique" :
                          err?.type === "invalid"   ? "Must be a whole number (integer)" : ""
                        }
                      />
                      {err && (
                        <span style={{
                          position: "absolute", top: 4, right: 8,
                          fontSize: 9, fontWeight: 900, letterSpacing: "0.05em",
                          color: err.type === "duplicate" ? "#ff4444" : "#f59e0b",
                          pointerEvents: "none", userSelect: "none",
                        }}>
                          {err.type === "duplicate" ? "DUP" : "!INT"}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td style={S.td}>
                  <button style={S.btnGhost} onClick={() => removeTask(i)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 24, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#666" }}>
          <div style={{ width: 16, height: 16, border: "2px solid #f59e0b", background: "#1e1200", borderRadius: 3 }} />
          Non-integer value
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#666" }}>
          <div style={{ width: 16, height: 16, border: "2px solid #ff3333", background: "#2a0808", borderRadius: 3 }} />
          Duplicate Task ID
        </div>
      </div>
    </div>
  );
}

// ─── PERT Tab ─────────────────────────────────────────────────────────────────

function PERTTab({ tasks }) {
  return (
    <div>
      <div style={S.sectionTitle}>PERT Duration Estimates</div>
      <div style={S.sectionSub}>Formula: (O + 4M + P) / 6 &nbsp;·&nbsp; σ = (P − O) / 6</div>
      <div style={{ overflowX: "auto", marginTop: 20 }}>
        <table style={S.table}>
          <thead>
            <tr>{["Task", "O", "M", "P", "Expected Duration", "Std Dev σ", "Variance σ²"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {tasks.map((t, i) => {
              const o = +t.o, m = +t.m, p = +t.p;
              const exp = computePERT(o, m, p);
              const sd = (p - o) / 6;
              return (
                <tr key={i}>
                  <td style={{ ...S.td, color: "#4ade80", fontWeight: 700, fontSize: 16 }}>{t.id}</td>
                  <td style={S.td}>{o}</td><td style={S.td}>{m}</td><td style={S.td}>{p}</td>
                  <td style={{ ...S.td, color: "#f0f0f0", fontWeight: 700, fontSize: 15 }}>{exp.toFixed(2)}</td>
                  <td style={S.td}>{sd.toFixed(3)}</td>
                  <td style={S.td}>{(sd * sd).toFixed(4)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Network Graph ────────────────────────────────────────────────────────────

function NetworkGraph({ computed }) {
  const { nodes, ES, EF, LS, LF, slack, criticalPath, positions } = computed;
  const W = 1140, H = 480;
  return (
    <div>
      <div style={S.sectionTitle}>Network Diagram</div>
      <div style={S.sectionSub}>Each node: top-left = ES, top-right = EF, bottom-left = LS, bottom-right = LF. Red = critical path.</div>
      <div style={{ display: "flex", gap: 20, margin: "14px 0" }}>
        {[["#ff4444", "Critical Path"], ["#2a4a6a", "Non-Critical"]].map(([c, l]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#888" }}>
            <div style={{ width: 28, height: 3, background: c, borderRadius: 2 }} />{l}
          </div>
        ))}
      </div>
      <div style={{ background: "#090d14", border: "1px solid #1e293b", borderRadius: 10, overflow: "auto", padding: 8 }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
          <defs>
            <marker id="arrowRed" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
              <path d="M0,0 L0,7 L9,3.5 z" fill="#ff4444" />
            </marker>
            <marker id="arrowGray" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
              <path d="M0,0 L0,7 L9,3.5 z" fill="#2a4a6a" />
            </marker>
          </defs>
          {Object.keys(nodes).map(id =>
            nodes[id].predecessors.map(pred => {
              const from = positions[pred], to = positions[id];
              if (!from || !to) return null;
              const isCrit = criticalPath.includes(id) && criticalPath.includes(pred);
              const dx = to.x - from.x, dy = to.y - from.y;
              const len = Math.sqrt(dx * dx + dy * dy);
              const nx = dx / len, ny = dy / len;
              return (
                <line key={`${pred}-${id}`}
                  x1={from.x + nx * 40} y1={from.y + ny * 40}
                  x2={to.x - nx * 40} y2={to.y - ny * 40}
                  stroke={isCrit ? "#ff4444" : "#2a4a6a"} strokeWidth={isCrit ? 2.5 : 1.5}
                  markerEnd={isCrit ? "url(#arrowRed)" : "url(#arrowGray)"}
                />
              );
            })
          )}
          {Object.keys(nodes).map(id => {
            const { x, y } = positions[id];
            const isCrit = criticalPath.includes(id);
            const nw = 88, nh = 80;
            return (
              <g key={id}>
                <rect x={x - nw/2} y={y - nh/2} width={nw} height={nh} rx={6}
                  fill={isCrit ? "#1a0505" : "#0d1829"}
                  stroke={isCrit ? "#ff4444" : "#1e3a5a"} strokeWidth={isCrit ? 2.5 : 1.5} />
                <line x1={x - nw/2} y1={y} x2={x + nw/2} y2={y} stroke={isCrit ? "#3a1010" : "#1a2f4a"} strokeWidth={1} />
                <line x1={x} y1={y - nh/2} x2={x} y2={y + nh/2} stroke={isCrit ? "#3a1010" : "#1a2f4a"} strokeWidth={1} />
                <text x={x} y={y-18} textAnchor="middle" fontSize={15} fontWeight={800} fill={isCrit ? "#ff5555" : "#4ade80"} fontFamily="IBM Plex Mono,monospace">{id}</text>
                <text x={x} y={y-4}  textAnchor="middle" fontSize={10} fill="#666" fontFamily="IBM Plex Mono,monospace">{nodes[id].duration.toFixed(1)}d</text>
                <text x={x-22} y={y+16} textAnchor="middle" fontSize={10} fill="#7dd3fc" fontFamily="IBM Plex Mono,monospace">{ES[id].toFixed(1)}</text>
                <text x={x+22} y={y+16} textAnchor="middle" fontSize={10} fill="#7dd3fc" fontFamily="IBM Plex Mono,monospace">{EF[id].toFixed(1)}</text>
                <text x={x-22} y={y+32} textAnchor="middle" fontSize={10} fill={isCrit ? "#ff9999" : "#64748b"} fontFamily="IBM Plex Mono,monospace">{LS[id].toFixed(1)}</text>
                <text x={x+22} y={y+32} textAnchor="middle" fontSize={10} fill={isCrit ? "#ff9999" : "#64748b"} fontFamily="IBM Plex Mono,monospace">{LF[id].toFixed(1)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ fontSize: 11, color: "#444", marginTop: 8 }}>Top row: ES | EF &nbsp;·&nbsp; Bottom row: LS | LF</div>
    </div>
  );
}

// ─── CPM Analysis ─────────────────────────────────────────────────────────────

function CPMAnalysis({ computed }) {
  const { nodes, ES, EF, LS, LF, slack, criticalPath, projectEnd, pathDurations } = computed;
  return (
    <div>
      <div style={S.sectionTitle}>CPM Analysis</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, margin: "20px 0" }}>
        {[
          { val: projectEnd.toFixed(1), label: "PROJECT DURATION (DAYS)", color: "#4ade80" },
          { val: criticalPath.join("→"), label: "CRITICAL PATH", color: "#ff4444" },
          { val: criticalPath.length, label: "CRITICAL TASKS", color: "#f0f0f0" },
          { val: Object.values(slack).filter(s => s > 0 && s <= 2).length, label: "NEAR-CRITICAL (SLACK ≤ 2)", color: "#f59e0b" },
        ].map(m => (
          <div key={m.label} style={S.metricCard}>
            <div style={{ fontSize: 28, fontWeight: 800, color: m.color, lineHeight: 1, wordBreak: "break-all" }}>{m.val}</div>
            <div style={{ fontSize: 11, color: "#555", marginTop: 6, letterSpacing: "0.08em" }}>{m.label}</div>
          </div>
        ))}
      </div>
      <div style={{ overflowX: "auto", marginBottom: 24 }}>
        <table style={S.table}>
          <thead><tr>{["Task","Duration","ES","EF","LS","LF","Slack","Status"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {Object.keys(nodes).map(id => {
              const isCrit = criticalPath.includes(id);
              const sl = slack[id];
              const isNear = !isCrit && sl <= 2;
              return (
                <tr key={id} style={{ background: isCrit ? "#1a0505" : undefined }}>
                  <td style={{ ...S.td, color: isCrit ? "#ff6666" : "#4ade80", fontWeight: 800, fontSize: 15 }}>{id}</td>
                  <td style={S.td}>{nodes[id].duration.toFixed(2)}</td>
                  <td style={{ ...S.td, color: "#7dd3fc" }}>{ES[id].toFixed(2)}</td>
                  <td style={{ ...S.td, color: "#7dd3fc" }}>{EF[id].toFixed(2)}</td>
                  <td style={{ ...S.td, color: isCrit ? "#ff9999" : "#94a3b8" }}>{LS[id].toFixed(2)}</td>
                  <td style={{ ...S.td, color: isCrit ? "#ff9999" : "#94a3b8" }}>{LF[id].toFixed(2)}</td>
                  <td style={{ ...S.td, fontWeight: 700, fontSize: 15, color: isCrit ? "#ff4444" : isNear ? "#f59e0b" : "#4ade80" }}>{sl.toFixed(2)}</td>
                  <td style={S.td}>
                    {isCrit ? <span style={S.tagCrit}>CRITICAL</span>
                      : isNear ? <span style={S.tagNear}>NEAR-CRITICAL</span>
                        : <span style={S.tagFree}>Float: {sl.toFixed(1)}d</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ ...S.sectionTitle, fontSize: 16, marginBottom: 12 }}>All Network Paths</div>
      <div style={{ overflowX: "auto" }}>
        <table style={S.table}>
          <thead><tr>{["#","Path","Duration",""].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {pathDurations.map((p, i) => (
              <tr key={i} style={{ background: i === 0 ? "#1a0505" : undefined }}>
                <td style={{ ...S.td, color: "#555" }}>{i+1}</td>
                <td style={{ ...S.td, color: i===0 ? "#ff8888" : "#94a3b8", fontWeight: i===0 ? 700 : 400 }}>{p.path.join(" → ")}</td>
                <td style={{ ...S.td, fontWeight: 700, fontSize: 15, color: i===0 ? "#ff4444" : "#e0e0e0" }}>{p.duration.toFixed(2)}</td>
                <td style={S.td}>{i===0 && <span style={S.tagCrit}>CRITICAL</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Crash Analysis ───────────────────────────────────────────────────────────

function CrashAnalysis({ computed, crashDays, setCrashDays, crashPlan, crashPlan1More }) {
  const { nodes, criticalPath, projectEnd } = computed;
  const crashCostPerDay = id => {
    const n = nodes[id];
    const avail = n.duration - n.crashTime;
    if (avail <= 0) return Infinity;
    return (n.crashCost - n.normalCost) / avail;
  };
  return (
    <div>
      <div style={S.sectionTitle}>Crash Analysis</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 20, marginBottom: 24 }}>
        <div>
          <div style={S.subLabel}>CRITICAL PATH CRASH OPTIONS</div>
          <table style={S.table}>
            <thead><tr>{["Task","Normal Dur","Crash Limit","Max Reduce","Cost/Day (Rs.000)"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {criticalPath.map(id => {
                const n = nodes[id];
                const avail = n.duration - n.crashTime;
                const cpd = crashCostPerDay(id);
                const isBest = cpd === Math.min(...criticalPath.map(crashCostPerDay));
                return (
                  <tr key={id}>
                    <td style={{ ...S.td, color: "#ff6666", fontWeight: 800 }}>{id}</td>
                    <td style={S.td}>{n.duration.toFixed(1)}</td>
                    <td style={S.td}>{n.crashTime}</td>
                    <td style={S.td}>{avail.toFixed(1)} days</td>
                    <td style={{ ...S.td, color: isBest ? "#4ade80" : "#e0e0e0", fontWeight: 700, fontSize: 15 }}>{cpd === Infinity ? "—" : cpd.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div>
          <div style={S.subLabel}>CRASH SIMULATION</div>
          <div style={S.card}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#666", marginBottom: 8, letterSpacing: "0.06em" }}>TARGET REDUCTION (DAYS)</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input type="number" value={crashDays} onChange={e => setCrashDays(+e.target.value)}
                  style={{ ...S.input, width: 90, fontSize: 20, fontWeight: 700, textAlign: "center" }} min={1} max={20} />
                <span style={{ fontSize: 12, color: "#555" }}>days</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { val: projectEnd.toFixed(1), label: "CURRENT", color: "#f0f0f0" },
                { val: (projectEnd - crashDays).toFixed(1), label: "TARGET", color: "#f59e0b" },
              ].map(m => (
                <div key={m.label} style={S.metricCard}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: m.color }}>{m.val}</div>
                  <div style={{ fontSize: 10, color: "#555", marginTop: 4, letterSpacing: "0.08em" }}>{m.label} DURATION</div>
                </div>
              ))}
              <div style={{ ...S.metricCard, gridColumn: "1/-1" }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#ff8888" }}>
                  {crashPlan ? `+${crashPlan.totalExtra.toFixed(1)}k` : "—"}
                </div>
                <div style={{ fontSize: 10, color: "#555", marginTop: 4, letterSpacing: "0.08em" }}>ADDITIONAL COST (Rs. 000)</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {crashPlan && (
        <>
          <div style={S.subLabel}>CRASH SCHEDULE — DAY BY DAY</div>
          <div style={{ overflowX: "auto", marginBottom: 20 }}>
            <table style={S.table}>
              <thead><tr>{["Day Reduced","Task Crashed","Cost This Day (Rs. 000)","Cumulative Extra Cost"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {crashPlan.crashLog.map((log, i) => (
                  <tr key={i}>
                    <td style={{ ...S.td, color: "#555" }}>−{log.day} day{log.day > 1 ? "s" : ""}</td>
                    <td style={{ ...S.td, color: "#ff6666", fontWeight: 700, fontSize: 15 }}>{log.task || log.note}</td>
                    <td style={S.td}>{log.costPerDay ? log.costPerDay.toFixed(1) : "—"}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: "#f59e0b", fontSize: 15 }}>{log.cumCost ? log.cumCost.toFixed(1) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {crashPlan1More?.crashLog[crashDays] && (
            <>
              <div style={S.subLabel}>+1 MORE DAY RECOMMENDATION</div>
              <div style={{ ...S.card, background: "#0a1a0a", border: "1px solid #1a3a1a" }}>
                <div style={{ fontSize: 15, color: "#f0f0f0", marginBottom: 8 }}>
                  Best task to crash on day {crashDays + 1}:
                  <span style={{ color: "#4ade80", fontWeight: 800, marginLeft: 10, fontSize: 18 }}>Task {crashPlan1More.crashLog[crashDays].task}</span>
                </div>
                <div style={{ fontSize: 13, color: "#666" }}>
                  Additional cost: <span style={{ color: "#f59e0b", fontWeight: 700 }}>Rs. {crashPlan1More.crashLog[crashDays].costPerDay?.toFixed(1)}k</span>
                  &nbsp;·&nbsp; Cheapest remaining critical path option
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  root: { fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#080c12", minHeight: "100vh", color: "#c8d8e8", fontSize: 14 },
  header: { background: "#0a0e17", borderBottom: "1px solid #1a2535", padding: "18px 40px", display: "flex", alignItems: "center", gap: 16 },
  headerDot: { width: 10, height: 10, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 14px #4ade80", flexShrink: 0 },
  headerTitle: { fontFamily: "'IBM Plex Mono',monospace", fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", color: "#f0f0f0" },
  headerSub: { marginLeft: "auto", fontSize: 11, color: "#334", letterSpacing: "0.12em" },
  tabBar: { background: "#0a0e17", borderBottom: "1px solid #1a2535", padding: "0 40px", display: "flex" },
  tabBtn: { background: "none", border: "none", cursor: "pointer", padding: "14px 22px", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, letterSpacing: "0.04em", color: "#556", borderBottom: "2px solid transparent", transition: "all 0.15s" },
  tabBtnActive: { color: "#4ade80", borderBottomColor: "#4ade80" },
  content: { padding: "32px 40px", maxWidth: "100%" },
  sectionTitle: { fontFamily: "'IBM Plex Mono',monospace", fontSize: 22, fontWeight: 700, color: "#f0f0f0", marginBottom: 4 },
  sectionSub: { fontSize: 12, color: "#445", marginBottom: 4 },
  subLabel: { fontSize: 11, color: "#556", letterSpacing: "0.1em", marginBottom: 10, marginTop: 4 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { background: "#0a0e17", color: "#4ade80", padding: "11px 16px", textAlign: "left", borderBottom: "1px solid #1a2535", fontWeight: 600, letterSpacing: "0.07em", fontSize: 11, whiteSpace: "nowrap" },
  td: { padding: "10px 16px", borderBottom: "1px solid #111b27", fontSize: 14, whiteSpace: "nowrap" },
  input: { background: "#0d1520", border: "1px solid #1e2f45", color: "#e0e0e0", padding: "7px 10px", borderRadius: 4, fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, width: "100%", outline: "none" },
  btnGenerate: { background: "#4ade80", color: "#000", border: "none", padding: "11px 28px", borderRadius: 6, cursor: "pointer", fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, fontWeight: 800, letterSpacing: "0.04em", transition: "all 0.15s", boxShadow: "0 0 18px #4ade8055" },
  btnSecondary: { background: "transparent", border: "1px solid #2a4a3a", color: "#4ade80", padding: "10px 20px", borderRadius: 6, cursor: "pointer", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 600, transition: "all 0.15s" },
  btnGhost: { background: "transparent", border: "1px solid #2a3a4a", color: "#666", padding: "5px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, transition: "all 0.15s" },
  metricCard: { background: "#0a0e17", border: "1px solid #1a2535", borderRadius: 8, padding: "16px 20px" },
  card: { background: "#0d1520", border: "1px solid #1a2535", borderRadius: 8, padding: "20px" },
  errBox: { background: "#1a0505", border: "1px solid #ff3333", borderRadius: 6, padding: "12px 18px", marginBottom: 12, color: "#ff9999", fontSize: 13 },
  warnBox: { background: "#1a1000", border: "1px solid #f59e0b", borderRadius: 6, padding: "12px 18px", marginBottom: 12, color: "#fbbf24", fontSize: 13 },
  successBox: { background: "#0a1a0a", border: "1px solid #4ade80", borderRadius: 6, padding: "12px 18px", marginBottom: 12, color: "#4ade80", fontSize: 13 },
  tagCrit: { background: "#ff4444", color: "white", padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700 },
  tagNear: { background: "#f59e0b", color: "#000", padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700 },
  tagFree: { background: "#1a2535", color: "#556", padding: "3px 10px", borderRadius: 4, fontSize: 11 },
};

const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080c12; }
  ::-webkit-scrollbar { width: 7px; height: 7px; }
  ::-webkit-scrollbar-track { background: #0a0e17; }
  ::-webkit-scrollbar-thumb { background: #1e3050; border-radius: 4px; }
  input:focus { outline: 2px solid #4ade80 !important; outline-offset: -1px; }
  button:hover { opacity: 0.85; }
  tr:hover td { background: #0d1829 !important; }
`;
