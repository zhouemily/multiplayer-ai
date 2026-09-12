const POLL_MS = 1000;
const $ = (sel) => document.querySelector(sel);

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
  for (const agent of agents) {
    const claimedTasks = tasks.filter((t) => t.claimedBy === agent.id);
    const card = el("div", "agent-card" + (claimedTasks.length ? " working" : ""));
    card.id = `agent-card-${agent.id}`;

    const name = el("div", "agent-name", agent.name);
    const status = el("div", "agent-status");
    if (claimedTasks.length) {
      status.append(el("span", "pulse"));
      status.append(el("b", null, `working on ${claimedTasks.map((t) => t.id).join(", ")}`));
    } else {
      status.textContent = claimedAny(tasks) ? "waiting for work…" : "board clear — idle";
    }
    card.append(name, status);
    list.append(card);
  }
}

function claimedAny(tasks) {
  return tasks.some((t) => t.claimedBy);
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
  for (const status of ["todo", "in_progress", "done"]) {
    const col = $(`#col-${status}`);
    col.innerHTML = "";
    for (const task of tasks.filter((t) => t.status === status)) {
      col.append(taskCard(task));
    }
    $(`#count-${status}`).textContent = `(${tasks.filter((t) => t.status === status).length})`;
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

  const json = JSON.stringify(state);
  if (json !== lastStateJson) {
    lastStateJson = json;
    renderAgents(state.agents, state.tasks);
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
