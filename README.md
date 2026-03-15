# CPMpro - Critical Path Method Analyzer

> A professional, browser-based project scheduling tool built with React and Vite.  
> PERT estimation · CPM analysis · Crash optimization · Monte Carlo simulation · Gantt · EVM

---

## Overview

CPMpro is a full-featured project scheduling application that implements the **Critical Path Method (CPM)** with **PERT three-point estimation**. It takes a table of tasks with predecessors and duration estimates, then computes the critical path, slack times, crash plans, and probabilistic completion forecasts - entirely in the browser with no backend required.

Built as a learning tool for the MN4151 Project Management module at the University of Moratuwa, but general-purpose enough for any engineering project schedule.

---

## Features

### Input & Validation
- Editable task table with drag-to-reorder rows
- Fields: Task ID, Predecessors, Optimistic/Most Likely/Pessimistic durations, Normal Cost, Crash Cost, Crash Time, Resource
- **Generate button** - triggers validation before computation
- Cell-level error highlighting:
  - 🟠 Orange - non-integer value in a numeric field
  - 🔴 Red - duplicate Task ID
  - ⚠ Yellow - logic warnings (e.g. crash time ≥ expected duration)
- Tooltips on every field with hints and error messages
- Load example data, clear all, add/remove tasks
- Save and load named **Scenarios** (persisted to `localStorage`)
- Import/export as **JSON**, export results as **CSV**

### PERT Estimates
- Computes expected duration: `(O + 4M + P) / 6`
- Standard deviation: `(P − O) / 6`
- Variance and 95% confidence range per task

### Network Diagram
- Auto-laid-out directed acyclic graph (DAG)
- Each node shows: Task ID, duration, slack, ES/EF (top), LS/LF (bottom)
- Critical path edges in red, near-critical in amber, free in grey
- Curved edges with arrowheads
- Zoom (scroll wheel) and pan (drag) with zoom controls

### CPM Analysis
- Forward pass (ES, EF) and backward pass (LS, LF)
- Slack / float per task
- Critical, near-critical (slack ≤ 2), and free task classification
- Summary metrics: project duration, critical path, std dev
- Full enumeration of all network paths ranked by duration

### Crash Analysis
- Crash cost per day for each critical task
- Simulation: select target day reduction, view cheapest crash schedule day-by-day
- Cumulative cost tracking
- +1 day recommendation with justification

### Gantt Chart
- Early-start schedule with bar per task
- Slack extensions shown as translucent bars
- Optional late-start overlay
- Colour-coded by criticality
- Day tick marks and project end marker

### Monte Carlo Simulation
- 5,000-iteration probabilistic schedule simulation
- Normal approximation sampling on PERT estimates
- Histogram of completion time distribution
- P10, P50, P80, P90 percentile markers
- Mean and standard deviation of project duration

### EVM / EMV
- Earned Value Management metrics
- Expected Monetary Value calculation

### Resource Management
- Resource assignment per task
- Resource histogram / utilisation view

### UI / UX
- Dark and light theme toggle
- Persistent storage (tasks and scenarios survive page refresh)
- Print-friendly report view (`⎙ Print`)
- Status bar showing live project summary after generation
- Responsive layout

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 |
| Build tool | Vite |
| Styling | Inline styles + CSS variables (no Tailwind, no external UI lib) |
| Fonts | JetBrains Mono, Syne (Google Fonts) |
| Persistence | `localStorage` |
| Deployment | Vercel |

No external charting or graph libraries. All algorithms (topological sort, forward/backward pass, crash optimisation, Monte Carlo) are implemented from scratch.

---

## Getting Started

### Prerequisites

- Node.js v18+ ([nodejs.org](https://nodejs.org))
- Git ([git-scm.com](https://git-scm.com))

### Local Development

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/cpm-app.git
cd cpm-app

# Install dependencies
npm install

# Start dev server
npm run dev
```

Open `http://localhost:5173` in your browser.

### Build for Production

```bash
npm run build
```

Output is in the `dist/` folder.

---

## Deployment

The app is deployed on **Vercel**. Any push to `main` triggers an automatic redeploy.

```bash
git add .
git commit -m "your message"
git push
```

To deploy from scratch:

1. Push the repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project**
3. Select the repo - Vercel auto-detects Vite
4. Click **Deploy**

---

## Project Structure

```
cpm-app/
├── src/
│   ├── App.jsx          # Entire application (single-file architecture)
│   └── main.jsx         # React entry point
├── index.html
├── package.json
├── vite.config.js
└── README.md
```

The app uses a **single-file architecture** - all components, logic, styles, and constants live in `App.jsx`. This was an intentional choice for portability and simplicity.

---

## Algorithm Notes

### PERT Three-Point Estimation
Expected duration uses a weighted Beta distribution approximation:
```
E = (O + 4M + P) / 6
σ = (P − O) / 6
```

### Critical Path Method
1. **Topological sort** - Kahn's algorithm variant using DFS
2. **Forward pass** - compute Early Start (ES) and Early Finish (EF)
3. **Backward pass** - compute Late Start (LS) and Late Finish (LF)
4. **Slack** = LS − ES; tasks with slack = 0 are on the critical path

### Crash Optimisation
Greedy algorithm: at each step, identify the cheapest critical task with remaining crash capacity and reduce its duration by one day. Repeats until target reduction is met or no further crashing is possible.

### Monte Carlo
For each iteration, task durations are sampled from a normal distribution `N(E, σ²)` clipped at the crash time lower bound. Project completion is computed via forward pass. 5,000 iterations produce a stable empirical distribution.

---

## Screenshots

> Network diagram, Gantt chart, and CPM analysis table screenshots can be added here.

---

## License

MIT

---

## Author

Built by [Kavishka](https://github.com/kavishka-dot) · University of Moratuwa · 2025
