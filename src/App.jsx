import { useState, useEffect, useRef, useCallback } from "react";

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

function computePERT(o, m, p) {
  return (o + 4 * m + p) / 6;
}

function buildGraph(tasks) {
  const nodes = {};
  tasks.forEach(t => {
    const dur = computePERT(+t.o, +t.m, +t.p);
    nodes[t.id] = {
      id: t.id,
      duration: parseFloat(dur.toFixed(2)),
      predecessors: t.predecessors ? t.predecessors.split(",").map(s => s.trim()).filter(Boolean) : [],
      normalCost: +t.normalCost,
      crashCost: +t.crashCost,
      crashTime: +t.crashTime,
    };
  });
  return nodes;
}

function forwardPass(nodes) {
  const order = topoSort(nodes);
  const ES = {}, EF = {};
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

function computeSlack(ES, EF, LS, LF) {
  const slack = {};
  Object.keys(ES).forEach(id => {
    slack[id] = parseFloat((LS[id] - ES[id]).toFixed(4));
  });
  return slack;
}

function findAllPaths(nodes) {
  const starts = Object.keys(nodes).filter(id => nodes[id].predecessors.length === 0);
  const ends = Object.keys(nodes).filter(id =>
    !Object.values(nodes).some(n => n.predecessors.includes(id))
  );
  const paths = [];
  function dfs(current, path) {
    path = [...path, current];
    if (ends.includes(current)) { paths.push(path); return; }
    const succs = Object.keys(nodes).filter(k => nodes[k].predecessors.includes(current));
    if (succs.length === 0) { paths.push(path); return; }
    succs.forEach(s => dfs(s, path));
  }
  starts.forEach(s => dfs(s, []));
  return paths;
}

function layoutNodes(nodes, ES, EF) {
  const order = topoSort(nodes);
  const levels = {};
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
  const W = 760, H = 320;
  const xStep = W / (maxLevel + 1);
  Object.keys(byLevel).forEach(lvl => {
    const items = byLevel[lvl];
    const yStep = H / (items.length + 1);
    items.forEach((id, i) => {
      positions[id] = {
        x: 60 + parseInt(lvl) * xStep,
        y: 40 + (i + 1) * yStep,
      };
    });
  });
  return positions;
}

const TABS = ["Input", "PERT Estimates", "Network Graph", "CPM Analysis", "Crash Analysis"];

export default function App() {
  const [tasks, setTasks] = useState(DEFAULT_TASKS);
  const [activeTab, setActiveTab] = useState(0);
  const [computed, setComputed] = useState(null);
  const [error, setError] = useState("");
  const [crashDays, setCrashDays] = useState(4);

  useEffect(() => { compute(); }, [tasks]);

  function compute() {
    try {
      const nodes = buildGraph(tasks);
      const { ES, EF, order } = forwardPass(nodes);
      const { LS, LF, projectEnd } = backwardPass(nodes, ES, EF, order);
      const slack = computeSlack(ES, EF, LS, LF);
      const criticalPath = order.filter(id => Math.abs(slack[id]) < 0.001);
      const positions = layoutNodes(nodes, ES, EF);
      const allPaths = findAllPaths(nodes);
      const pathDurations = allPaths.map(path => ({
        path,
        duration: path.reduce((s, id) => s + nodes[id].duration, 0),
      })).sort((a, b) => b.duration - a.duration);
      setComputed({ nodes, ES, EF, LS, LF, slack, criticalPath, projectEnd, positions, allPaths, pathDurations, order });
      setError("");
    } catch (e) {
      setError("Check your inputs — " + e.message);
    }
  }

  function updateTask(i, field, val) {
    setTasks(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t));
  }

  function addTask() {
    setTasks(prev => [...prev, { id: String.fromCharCode(65 + prev.length), predecessors: "", o: 1, m: 3, p: 5, normalCost: 100, crashCost: 150, crashTime: 2 }]);
  }

  function removeTask(i) {
    setTasks(prev => prev.filter((_, idx) => idx !== i));
  }

  function computeCrashPlan(targetDays) {
    if (!computed) return null;
    const { nodes, criticalPath, projectEnd } = computed;
    let currentEnd = projectEnd;
    const crashLog = [];
    const remaining = {};
    Object.keys(nodes).forEach(id => {
      remaining[id] = nodes[id].duration - nodes[id].crashTime;
    });
    let totalExtra = 0;
    for (let day = 0; day < targetDays; day++) {
      // recompute with current durations
      const tempNodes = {};
      Object.keys(nodes).forEach(id => {
        tempNodes[id] = { ...nodes[id], duration: nodes[id].duration - (remaining[id] < 0 ? 0 : nodes[id].duration - nodes[id].crashTime - remaining[id]) };
      });
      // find critical tasks with crash available
      const { ES: tES, EF: tEF, order: tOrd } = forwardPass(tempNodes);
      const { LS: tLS, projectEnd: tEnd } = backwardPass(tempNodes, tES, tEF, tOrd);
      const tSlack = computeSlack(tES, tEF, tLS, {});
      const critTasks = tOrd.filter(id => Math.abs(tLS[id] - tES[id]) < 0.001 && remaining[id] > 0);
      if (critTasks.length === 0) { crashLog.push({ day: day + 1, note: "No more crashing possible" }); break; }
      // pick cheapest
      const costPerDay = id => (nodes[id].crashCost - nodes[id].normalCost) / (nodes[id].duration - nodes[id].crashTime);
      const best = critTasks.reduce((a, b) => costPerDay(a) <= costPerDay(b) ? a : b);
      remaining[best] -= 1;
      const cost = costPerDay(best);
      totalExtra += cost;
      crashLog.push({ day: day + 1, task: best, costPerDay: cost, cumCost: totalExtra });
    }
    return { crashLog, totalExtra };
  }

  const crashPlan = computed ? computeCrashPlan(crashDays) : null;
  const crashPlan1More = computed ? computeCrashPlan(crashDays + 1) : null;

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', 'Courier New', monospace", background: "#0a0a0f", minHeight: "100vh", color: "#e0e0e0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;600;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #111; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        input { background: #111827; border: 1px solid #2a2a3a; color: #e0e0e0; padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: 12px; width: 100%; }
        input:focus { outline: none; border-color: #4ade80; }
        .tab-btn { background: none; border: none; cursor: pointer; padding: 10px 18px; font-family: inherit; font-size: 12px; letter-spacing: 0.05em; transition: all 0.2s; color: #666; border-bottom: 2px solid transparent; }
        .tab-btn.active { color: #4ade80; border-bottom-color: #4ade80; }
        .tab-btn:hover { color: #a3e635; }
        .card { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
        .tag-critical { background: #ff4444; color: white; padding: 2px 8px; border-radius: 3px; font-size: 11px; }
        .tag-near { background: #f59e0b; color: black; padding: 2px 8px; border-radius: 3px; font-size: 11px; }
        .tag-free { background: #1e293b; color: #666; padding: 2px 8px; border-radius: 3px; font-size: 11px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { background: #0f172a; color: #4ade80; padding: 8px 12px; text-align: left; border-bottom: 1px solid #1e293b; font-weight: 600; letter-spacing: 0.08em; font-size: 11px; }
        td { padding: 7px 12px; border-bottom: 1px solid #1a2030; }
        tr:hover td { background: #0f1929; }
        .crit-row td { background: #1a0f0f; }
        .crit-row:hover td { background: #200f0f; }
        .btn { background: #4ade80; color: #000; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600; transition: all 0.2s; }
        .btn:hover { background: #86efac; }
        .btn-ghost { background: transparent; border: 1px solid #333; color: #999; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 11px; transition: all 0.2s; }
        .btn-ghost:hover { border-color: #ff4444; color: #ff4444; }
        .metric { background: #0f172a; border: 1px solid #1e293b; border-radius: 6px; padding: 12px 16px; }
        .metric-val { font-size: 24px; font-weight: 700; color: #4ade80; line-height: 1; }
        .metric-label { font-size: 10px; color: #666; margin-top: 4px; letter-spacing: 0.1em; }
        svg text { font-family: 'IBM Plex Mono', monospace; }
      `}</style>

      {/* Header */}
      <div style={{ background: "#0d1117", borderBottom: "1px solid #1e293b", padding: "16px 28px", display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 12px #4ade80" }} />
        <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", color: "#f0f0f0" }}>
          CPM / PERT <span style={{ color: "#4ade80" }}>Analyzer</span>
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#444", letterSpacing: "0.1em" }}>CRITICAL PATH METHOD</span>
      </div>

      {/* Tabs */}
      <div style={{ background: "#0d1117", borderBottom: "1px solid #1e293b", padding: "0 28px", display: "flex" }}>
        {TABS.map((t, i) => (
          <button key={t} className={`tab-btn ${activeTab === i ? "active" : ""}`} onClick={() => setActiveTab(i)}>{t}</button>
        ))}
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
        {error && <div style={{ background: "#2a0f0f", border: "1px solid #ff4444", borderRadius: 6, padding: "10px 16px", marginBottom: 16, color: "#ff8888", fontSize: 12 }}>{error}</div>}

        {/* TAB 0: Input */}
        {activeTab === 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700, color: "#f0f0f0" }}>Task Table</div>
                <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>Enter task IDs, predecessors (comma-separated), PERT estimates, and cost data</div>
              </div>
              <button className="btn" onClick={addTask}>+ Add Task</button>
            </div>
            <div className="card" style={{ padding: 0, overflow: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Task ID</th>
                    <th>Predecessors</th>
                    <th>Optimistic (O)</th>
                    <th>Most Likely (M)</th>
                    <th>Pessimistic (P)</th>
                    <th>Normal Cost</th>
                    <th>Crash Cost</th>
                    <th>Crash Time</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t, i) => (
                    <tr key={i}>
                      {["id", "predecessors", "o", "m", "p", "normalCost", "crashCost", "crashTime"].map(f => (
                        <td key={f}><input value={t[f]} onChange={e => updateTask(i, f, e.target.value)} /></td>
                      ))}
                      <td><button className="btn-ghost" onClick={() => removeTask(i)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 1: PERT Estimates */}
        {activeTab === 1 && computed && (
          <div>
            <div style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700, color: "#f0f0f0", marginBottom: 4 }}>PERT Duration Estimates</div>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 16 }}>Formula: (O + 4M + P) / 6</div>
            <div className="card" style={{ padding: 0 }}>
              <table>
                <thead>
                  <tr><th>Task</th><th>O</th><th>M</th><th>P</th><th>Expected Duration</th><th>Std Dev σ</th><th>Variance σ²</th></tr>
                </thead>
                <tbody>
                  {tasks.map((t, i) => {
                    const o = +t.o, m = +t.m, p = +t.p;
                    const exp = computePERT(o, m, p);
                    const sd = (p - o) / 6;
                    return (
                      <tr key={i}>
                        <td style={{ color: "#4ade80", fontWeight: 700 }}>{t.id}</td>
                        <td>{o}</td><td>{m}</td><td>{p}</td>
                        <td style={{ color: "#f0f0f0", fontWeight: 600 }}>{exp.toFixed(2)}</td>
                        <td>{sd.toFixed(3)}</td>
                        <td>{(sd * sd).toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2: Network Graph */}
        {activeTab === 2 && computed && (
          <NetworkGraph computed={computed} />
        )}

        {/* TAB 3: CPM Analysis */}
        {activeTab === 3 && computed && (
          <CPMAnalysis computed={computed} />
        )}

        {/* TAB 4: Crash Analysis */}
        {activeTab === 4 && computed && (
          <CrashAnalysis computed={computed} crashDays={crashDays} setCrashDays={setCrashDays} crashPlan={crashPlan} crashPlan1More={crashPlan1More} />
        )}
      </div>
    </div>
  );
}

function NetworkGraph({ computed }) {
  const { nodes, ES, EF, LS, LF, slack, criticalPath, positions, projectEnd } = computed;
  const W = 820, H = 400;

  return (
    <div>
      <div style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700, color: "#f0f0f0", marginBottom: 4 }}>Network Diagram</div>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 16 }}>Nodes show ES | EF on top, LS | LF on bottom. Red = critical path.</div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#999" }}>
          <div style={{ width: 20, height: 3, background: "#ff4444" }} /> Critical Path
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#999" }}>
          <div style={{ width: 20, height: 3, background: "#334" }} /> Normal
        </div>
      </div>
      <div className="card" style={{ padding: 8, overflowX: "auto" }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {/* Edges */}
          {Object.keys(nodes).map(id =>
            nodes[id].predecessors.map(pred => {
              const from = positions[pred], to = positions[id];
              if (!from || !to) return null;
              const isCrit = criticalPath.includes(id) && criticalPath.includes(pred);
              const dx = to.x - from.x, dy = to.y - from.y;
              const len = Math.sqrt(dx * dx + dy * dy);
              const nx = dx / len, ny = dy / len;
              const r = 32;
              const x1 = from.x + nx * r, y1 = from.y + ny * r;
              const x2 = to.x - nx * r, y2 = to.y - ny * r;
              return (
                <g key={`${pred}-${id}`}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={isCrit ? "#ff4444" : "#2a3a4a"} strokeWidth={isCrit ? 2.5 : 1.5}
                    markerEnd={isCrit ? "url(#arrowRed)" : "url(#arrowGray)"} />
                </g>
              );
            })
          )}
          <defs>
            <marker id="arrowRed" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#ff4444" />
            </marker>
            <marker id="arrowGray" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#2a3a4a" />
            </marker>
          </defs>
          {/* Nodes */}
          {Object.keys(nodes).map(id => {
            const { x, y } = positions[id];
            const isCrit = criticalPath.includes(id);
            const sl = slack[id];
            return (
              <g key={id}>
                <rect x={x - 36} y={y - 34} width={72} height={68} rx={5}
                  fill={isCrit ? "#1a0808" : "#0f172a"}
                  stroke={isCrit ? "#ff4444" : "#2a3a4a"} strokeWidth={isCrit ? 2 : 1} />
                {/* Top row ES | EF */}
                <line x1={x - 36} y1={y - 10} x2={x + 36} y2={y - 10} stroke={isCrit ? "#3a1010" : "#1e293b"} strokeWidth={1} />
                <line x1={x} y1={y - 34} x2={x} y2={y + 34} stroke={isCrit ? "#3a1010" : "#1e293b"} strokeWidth={1} />
                {/* Center task ID */}
                <text x={x} y={y - 14} textAnchor="middle" fontSize={13} fontWeight={700}
                  fill={isCrit ? "#ff6666" : "#4ade80"}>{id}</text>
                {/* Duration */}
                <text x={x} y={y - 2} textAnchor="middle" fontSize={9} fill="#888">{nodes[id].duration.toFixed(1)}d</text>
                {/* ES | EF */}
                <text x={x - 18} y={y + 14} textAnchor="middle" fontSize={9} fill="#94a3b8">{ES[id].toFixed(1)}</text>
                <text x={x + 18} y={y + 14} textAnchor="middle" fontSize={9} fill="#94a3b8">{EF[id].toFixed(1)}</text>
                {/* LS | LF */}
                <text x={x - 18} y={y + 27} textAnchor="middle" fontSize={9} fill={isCrit ? "#ff8888" : "#64748b"}>{LS[id].toFixed(1)}</text>
                <text x={x + 18} y={y + 27} textAnchor="middle" fontSize={9} fill={isCrit ? "#ff8888" : "#64748b"}>{LF[id].toFixed(1)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ fontSize: 10, color: "#444", marginTop: 6 }}>Top row: ES | EF · Bottom row: LS | LF</div>
    </div>
  );
}

function CPMAnalysis({ computed }) {
  const { nodes, ES, EF, LS, LF, slack, criticalPath, projectEnd, pathDurations } = computed;
  const maxSlack = Math.max(...Object.values(slack));
  const nearThreshold = maxSlack > 0 ? Math.min(2, maxSlack * 0.2) : 0;

  return (
    <div>
      <div style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700, color: "#f0f0f0", marginBottom: 16 }}>CPM Analysis</div>

      {/* Metrics row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <div className="metric">
          <div className="metric-val">{projectEnd.toFixed(1)}</div>
          <div className="metric-label">PROJECT DURATION (DAYS)</div>
        </div>
        <div className="metric">
          <div className="metric-val" style={{ color: "#ff4444" }}>{criticalPath.join("→")}</div>
          <div className="metric-label">CRITICAL PATH</div>
        </div>
        <div className="metric">
          <div className="metric-val">{criticalPath.length}</div>
          <div className="metric-label">CRITICAL TASKS</div>
        </div>
        <div className="metric">
          <div className="metric-val" style={{ color: "#f59e0b" }}>{Object.values(slack).filter(s => s > 0 && s <= 2).length}</div>
          <div className="metric-label">NEAR-CRITICAL (SLACK ≤ 2)</div>
        </div>
      </div>

      {/* Task table */}
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <table>
          <thead>
            <tr><th>Task</th><th>Duration</th><th>ES</th><th>EF</th><th>LS</th><th>LF</th><th>Slack</th><th>Status</th></tr>
          </thead>
          <tbody>
            {Object.keys(nodes).map(id => {
              const isCrit = criticalPath.includes(id);
              const sl = slack[id];
              const isNear = !isCrit && sl <= 2;
              return (
                <tr key={id} className={isCrit ? "crit-row" : ""}>
                  <td style={{ color: isCrit ? "#ff6666" : "#4ade80", fontWeight: 700 }}>{id}</td>
                  <td>{nodes[id].duration.toFixed(2)}</td>
                  <td>{ES[id].toFixed(2)}</td>
                  <td>{EF[id].toFixed(2)}</td>
                  <td>{LS[id].toFixed(2)}</td>
                  <td>{LF[id].toFixed(2)}</td>
                  <td style={{ fontWeight: 700, color: isCrit ? "#ff4444" : isNear ? "#f59e0b" : "#4ade80" }}>{sl.toFixed(2)}</td>
                  <td>
                    {isCrit ? <span className="tag-critical">CRITICAL</span>
                      : isNear ? <span className="tag-near">NEAR-CRITICAL</span>
                        : <span className="tag-free">Float: {sl.toFixed(1)}d</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* All paths */}
      <div style={{ fontFamily: "'Space Grotesk'", fontSize: 14, fontWeight: 600, color: "#f0f0f0", marginBottom: 10 }}>All Network Paths</div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>#</th><th>Path</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {pathDurations.map((p, i) => (
              <tr key={i} style={i === 0 ? { background: "#1a0808" } : {}}>
                <td style={{ color: "#555" }}>{i + 1}</td>
                <td style={{ color: i === 0 ? "#ff8888" : "#94a3b8" }}>{p.path.join(" → ")}</td>
                <td style={{ fontWeight: 700, color: i === 0 ? "#ff4444" : "#e0e0e0" }}>{p.duration.toFixed(2)}</td>
                <td>{i === 0 && <span className="tag-critical">CRITICAL</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CrashAnalysis({ computed, crashDays, setCrashDays, crashPlan, crashPlan1More }) {
  const { nodes, criticalPath, projectEnd } = computed;

  const crashCostPerDay = id => {
    const n = nodes[id];
    const avail = n.duration - n.crashTime;
    if (avail <= 0) return Infinity;
    return (n.crashCost - n.normalCost) / (n.duration - n.crashTime);
  };

  return (
    <div>
      <div style={{ fontFamily: "'Space Grotesk'", fontSize: 20, fontWeight: 700, color: "#f0f0f0", marginBottom: 16 }}>Crash Analysis</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        {/* Crash cost table */}
        <div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 10, letterSpacing: "0.05em" }}>CRITICAL PATH CRASH OPTIONS</div>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Task</th><th>Normal Dur</th><th>Crash Time</th><th>Max Reduce</th><th>Cost/Day</th></tr></thead>
              <tbody>
                {criticalPath.map(id => {
                  const n = nodes[id];
                  const avail = n.duration - n.crashTime;
                  const cpd = crashCostPerDay(id);
                  return (
                    <tr key={id}>
                      <td style={{ color: "#ff6666", fontWeight: 700 }}>{id}</td>
                      <td>{n.duration.toFixed(1)}</td>
                      <td>{n.crashTime}</td>
                      <td>{avail.toFixed(1)} days</td>
                      <td style={{ color: cpd === Math.min(...criticalPath.map(crashCostPerDay)) ? "#4ade80" : "#e0e0e0", fontWeight: 700 }}>
                        {cpd.toFixed(1)}k
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Controls */}
        <div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 10, letterSpacing: "0.05em" }}>CRASH SIMULATION</div>
          <div className="card">
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>TARGET REDUCTION (DAYS)</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="number" value={crashDays} onChange={e => setCrashDays(+e.target.value)} style={{ width: 80 }} min={1} max={20} />
                <span style={{ fontSize: 11, color: "#555" }}>days to crash</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="metric">
                <div className="metric-val">{projectEnd.toFixed(1)}</div>
                <div className="metric-label">CURRENT DURATION</div>
              </div>
              <div className="metric">
                <div className="metric-val" style={{ color: "#f59e0b" }}>{(projectEnd - crashDays).toFixed(1)}</div>
                <div className="metric-label">TARGET DURATION</div>
              </div>
              <div className="metric" style={{ gridColumn: "1/-1" }}>
                <div className="metric-val" style={{ color: "#ff8888" }}>
                  {crashPlan ? `+${crashPlan.totalExtra.toFixed(1)}k` : "—"}
                </div>
                <div className="metric-label">ADDITIONAL COST (Rs. 000)</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Crash log */}
      {crashPlan && (
        <div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 10, letterSpacing: "0.05em" }}>CRASH SCHEDULE (CHEAPEST FIRST)</div>
          <div className="card" style={{ padding: 0, marginBottom: 16 }}>
            <table>
              <thead><tr><th>Day Reduced</th><th>Task Crashed</th><th>Cost This Day (Rs. 000)</th><th>Cumulative Extra Cost</th></tr></thead>
              <tbody>
                {crashPlan.crashLog.map((log, i) => (
                  <tr key={i}>
                    <td style={{ color: "#555" }}>Day −{log.day}</td>
                    <td style={{ color: "#ff6666", fontWeight: 700 }}>{log.task || log.note}</td>
                    <td>{log.costPerDay ? log.costPerDay.toFixed(1) : "—"}</td>
                    <td style={{ fontWeight: 700, color: "#f59e0b" }}>{log.cumCost ? log.cumCost.toFixed(1) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* +1 more day */}
          {crashPlan1More && crashPlan1More.crashLog[crashDays] && (
            <div>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 10, letterSpacing: "0.05em" }}>+1 MORE DAY ANALYSIS</div>
              <div className="card" style={{ background: "#0f1a0f", border: "1px solid #1a3a1a" }}>
                <div style={{ fontSize: 13, color: "#f0f0f0", marginBottom: 8 }}>
                  Best task to crash for day {crashDays + 1}:
                  <span style={{ color: "#4ade80", fontWeight: 700, marginLeft: 8 }}>
                    Task {crashPlan1More.crashLog[crashDays].task}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#888" }}>
                  Additional cost: <span style={{ color: "#f59e0b", fontWeight: 700 }}>Rs. {crashPlan1More.crashLog[crashDays].costPerDay?.toFixed(1)}k</span>
                  {" "}· Cheapest remaining critical path option
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
