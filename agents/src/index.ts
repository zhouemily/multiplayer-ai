import { optional } from "./env.js";
import { BoardClient, TaskView } from "./mcp.js";

const AGENT_ID = process.argv[2] === "b" ? "agent-b" : "agent-a";
const MCP_URL = optional("MCP_URL", "http://localhost:3333/mcp");
const WORK_MIN_MS = Number(optional("WORK_MIN_MS", "3000"));
const WORK_MAX_MS = Number(optional("WORK_MAX_MS", "9000"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const log = (msg: string) => console.log(`[${AGENT_ID}] ${new Date().toLocaleTimeString()} ${msg}`);

const RESULTS = [
  "Finished after checking 3 approaches — picked the simplest one.",
  "Drafted it, reviewed edge cases, tightened the wording.",
  "Completed with a quick first pass plus one round of self-review.",
  "Done — benchmarked two options and committed the faster one.",
];

function pickTask(tasks: TaskView[]): TaskView | null {
  const now = new Date().toISOString();
  // An in_progress task with an expired lease was abandoned — claim_task will
  // take it over, so it belongs in the pool alongside untouched work.
  const claimable = tasks.filter(
    (t) =>
      t.status === "todo" ||
      (t.status === "in_progress" && !!t.leaseExpiresAt && t.leaseExpiresAt <= now),
  );
  if (claimable.length === 0) return null;
  return claimable[Math.floor(Math.random() * claimable.length)];
}

async function main() {
  const board = new BoardClient(MCP_URL, AGENT_ID);
  await board.connect();
  log(`connected to shared board at ${MCP_URL}`);

  for (;;) {
    let tasks: TaskView[];
    try {
      tasks = await board.listTasks();
    } catch (err) {
      log(`board unreachable, retrying: ${String(err)}`);
      await sleep(2000);
      continue;
    }

    const target = pickTask(tasks);
    if (!target) {
      await sleep(1500);
      continue;
    }

    // Small jitter makes claim races visible in the activity feed.
    try {
      await sleep(rand(0, 600));
      const claim = await board.claimTask(target.id, AGENT_ID);
      if (!claim.ok) {
        log(`lost the race for ${target.id} (${claim.claimedBy ? `${claim.claimedBy} holds it` : claim.reason})`);
        await sleep(400);
        continue;
      }

      log(`claimed ${target.id} — "${target.title}"`);
      const workMs = rand(WORK_MIN_MS, WORK_MAX_MS);
      await sleep(workMs);

      const result = RESULTS[Math.floor(Math.random() * RESULTS.length)];
      await board.updateTask(
        target.id,
        "done",
        `${result} (${(workMs / 1000).toFixed(1)}s of work)`,
        AGENT_ID,
      );
      await board.releaseTask(target.id, AGENT_ID);
      log(`completed ${target.id} and released it`);
    } catch (err) {
      log(`work cycle on ${target.id} failed, carrying on: ${String(err)}`);
      await sleep(1000);
    }
  }
}

main().catch((err) => {
  console.error(`[${AGENT_ID}] fatal:`, err);
  process.exit(1);
});
