const POLL_MS = 1000;
const $ = (sel) => document.querySelector(sel);

/** The pipeline, in order. `done` is the finish line and gets no chip. */
const STEPS = [
  ["design", "design"],
  ["design_review", "design review"],
  ["execute", "execute"],
  ["execute_review", "execute review"],
];

/** Idle ephemeral workers pile up over a long demo; show a few and count the rest. */
const IDLE_AGENTS_SHOWN = 5;

let lastStateJson = "";
let lastMaxSeq = 0;

async function fetchState() {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderAgents(agents, tasks) {
  const list = $("#agent-list");
  list.innerHTML = "";

  const busy = (a) => tasks.some((t) => t.claimedBy === a.id);
  const rank = (a) => (a.role === "manager" ? 0 : busy(a) ? 1 : 2);
  const sorted = [...agents].sort((x, y) => rank(x) - rank(y));
  const idle = sorted.filter((a) => rank(a) === 2);
  const shown = sorted.filter((a) => rank(a) < 2).concat(idle.slice(0, IDLE_AGENTS_SHOWN));

  for (const agent of shown) {
    const claimedTasks = tasks.filter((t) => t.claimedBy === agent.id);
    const card = el("div", "agent-card" + (claimedTasks.length ? " working" : ""));
    if (agent.role === "manager") card.classList.add("manager");
    card.id = `agent-card-${agent.id}`;

    const name = el("div", "agent-name", agent.name);
    if (agent.role) name.append(el("span", "agent-role", agent.role));
    const status = el("div", "agent-status");
    if (claimedTasks.length) {
      status.append(el("span", "pulse"));
      status.append(el("b", null, `working on ${claimedTasks.map((t) => t.id).join(", ")}`));
    } else if (agent.role === "manager") {
      status.textContent = "delegating — never does the work";
    } else {
      status.textContent = claimedAny(tasks) ? "waiting for work…" : "board clear — idle";
    }
    card.append(name, status);
    list.append(card);
  }

  const hidden = idle.length - IDLE_AGENTS_SHOWN;
  if (hidden > 0) list.append(el("div", "agent-more", `+${hidden} idle subagents`));
}

function claimedAny(tasks) {
  return tasks.some((t) => t.claimedBy);
}

function subtaskRow(task) {
  const row = el("div", `subtask ${task.status}`);
  row.id = `task-card-${task.id}`;

  const top = el("div", "task-top");
  top.append(el("span", "task-id", task.id));
  top.append(el("span", "subtask-title", task.title));
  if (task.attempt > 1) top.append(el("span", "attempt", `attempt ${task.attempt}`));
  row.append(top);

  const pipe = el("div", "pipeline");
  for (const [step, label] of STEPS) {
    const chip = el("span", "chip", label);
    if (task.step === step) chip.classList.add("current");
    else if (isPast(step, task.step)) chip.classList.add("past");
    if (step.endsWith("_review")) chip.classList.add("review");
    pipe.append(chip);
  }
  row.append(pipe);

  const foot = el("div", "subtask-foot");
  if (task.status === "blocked") {
    foot.append(el("span", "flag blocked", `blocked after ${task.maxAttempts} attempts — needs the manager`));
  } else if (task.status === "done") {
    foot.append(el("span", "flag done", "done"));
  } else if (task.claimedBy) {
    foot.append(el("span", "pulse"));
    foot.append(el("span", "flag holder", `${task.claimedBy} is on ${labelFor(task.step)}`));
  } else {
    foot.append(el("span", "flag awaiting", `awaiting a subagent for ${labelFor(task.step)}`));
  }
  row.append(foot);

  if (task.result) row.append(el("div", "task-result", task.result));
  return row;
}

function labelFor(step) {
  const found = STEPS.find(([s]) => s === step);
  return found ? found[1] : step;
}

function isPast(step, current) {
  const order = STEPS.map(([s]) => s);
  if (current === "done") return true;
  return order.indexOf(step) < order.indexOf(current);
}

function renderProjects(projects, tasks) {
  const list = $("#project-list");
  list.innerHTML = "";
  $("#count-projects").textContent = `(${projects.length})`;

  if (projects.length === 0) {
    list.append(
      el("div", "empty", "No projects yet — ask your agent to start one with start_project."),
    );
    return;
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const project of projects) {
    const subtasks = project.subtaskIds.map((id) => byId.get(id)).filter(Boolean);
    const doneCount = subtasks.filter((t) => t.status === "done").length;
    const blocked = subtasks.some((t) => t.status === "blocked");

    const card = el("div", "project-card" + (blocked ? " has-blocked" : ""));
    const head = el("div", "project-head");
    head.append(el("span", "task-id", project.id));
    head.append(el("span", "project-goal", project.goal));
    head.append(el("span", "project-progress", `${doneCount}/${subtasks.length}`));
    card.append(head);

    for (const subtask of subtasks) card.append(subtaskRow(subtask));
    list.append(card);
  }
}

function taskCard(task) {
  const card = el("div", `task-card ${task.status}` + (task.claimedBy ? ` claimed-${task.claimedBy}` : ""));
  card.id = `task-card-${task.id}`;

  const top = el("div", "task-top");
  top.append(el("span", "task-id", task.id));
  if (task.claimedBy) {
    top.append(el("span", "task-claim", `${task.claimedBy} ⚡`));
  } else if (task.status === "in_progress") {
    top.append(el("span", "spinner"));
  }
  card.append(top);

  card.append(el("div", "task-title", task.title));
  if (task.result) card.append(el("div", "task-result", task.result));

  if (task.claimedBy) {
    const btn = el("button", "release-btn", "force release");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "releasing…";
      await fetch("/api/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id }),
      });
    });
    card.append(btn);
  }
  return card;
}

function renderTasks(tasks) {
  // Project subtasks live in the pipeline panel; this board is standalone work.
  const standalone = tasks.filter((t) => t.projectId === null);
  for (const status of ["todo", "in_progress", "done"]) {
    const col = $(`#col-${status}`);
    col.innerHTML = "";
    const inStatus = standalone.filter((t) => t.status === status);
    for (const task of inStatus) col.append(taskCard(task));
    $(`#count-${status}`).textContent = `(${inStatus.length})`;
  }
}

function renderEvents(events) {
  const list = $("#feed-list");
  list.innerHTML = "";
  const maxSeq = events.length ? events[0].seq : 0;
  for (const ev of events) {
    const item = el("li", "event" + (ev.seq > lastMaxSeq ? " fresh" : ""));
    item.append(el("span", `badge ${ev.type}`, ev.type.replace("_", " ")));
    item.append(el("span", "msg", ev.message));
    item.append(el("span", "time", new Date(ev.at).toLocaleTimeString()));
    list.append(item);
  }
  lastMaxSeq = maxSeq;
}

function drawEdges(agents, tasks) {
  const svg = $("#edges");
  svg.innerHTML = "";
  const main = document.querySelector("main").getBoundingClientRect();

  for (const agent of agents) {
    const agentEl = document.getElementById(`agent-card-${agent.id}`);
    if (!agentEl) continue;
    const a = agentEl.getBoundingClientRect();
    const x1 = a.right - main.left;
    const y1 = a.top + a.height / 2 - main.top;

    for (const taskId of agent.claimedTaskIds) {
      const taskEl = document.getElementById(`task-card-${taskId}`);
      if (!taskEl) continue;
      const t = taskEl.getBoundingClientRect();
      const x2 = t.left - main.left;
      const y2 = t.top + t.height / 2 - main.top;
      const mx = (x1 + x2) / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
      );
      path.setAttribute("class", `edge ${agent.id}`);
      svg.append(path);
    }
  }
}

async function poll() {
  let state;
  try {
    state = await fetchState();
    $("#conn").classList.add("ok");
    $("#conn-text").textContent = "live · graph in sync";
  } catch (err) {
    $("#conn").classList.remove("ok");
    $("#conn-text").textContent = "connection lost";
    return;
  }

  // serverTime changes every poll, so it is excluded — otherwise every panel
  // would be rebuilt each second and scroll positions would reset.
  const { serverTime, ...graph } = state;
  const json = JSON.stringify(graph);
  if (json !== lastStateJson) {
    lastStateJson = json;
    renderAgents(state.agents, state.tasks);
    renderProjects(state.projects, state.tasks);
    renderTasks(state.tasks);
    renderEvents(state.events);
    requestAnimationFrame(() => drawEdges(state.agents, state.tasks));
  }
}

$("#add-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#add-task-title");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
});

window.addEventListener("resize", () => {
  try {
    const state = JSON.parse(lastStateJson);
    drawEdges(state.agents, state.tasks);
  } catch {}
});

poll();
setInterval(poll, POLL_MS);
