import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { driver } from "../src/db.js";
import { optional } from "../src/env.js";

const MCP_URL = optional("MCP_URL", `http://localhost:${optional("MCP_PORT", "3333")}/mcp`);

interface ClaimResult {
  ok: boolean;
  taskId: string;
  agentId?: string;
  claimedBy?: string;
  reason?: string;
}

interface EventView {
  seq: number;
  type: string;
  agentId: string;
  taskId: string;
  message: string;
}

let failures = 0;

function check(label: string, pass: boolean, detail = ""): void {
  if (pass) {
    console.log(`ok   — ${label}`);
  } else {
    failures++;
    console.error(`FAIL — ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function main() {
  const client = new Client({ name: "lease-test", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === "text",
    )?.text;
    if (!text) throw new Error(`Tool ${name} returned no text`);
    return JSON.parse(text) as T;
  };

  // Standing in for an agent that died mid-task: its lease is never renewed, so
  // backdating it is exactly the state the board is left in after a crash.
  const expired = new Date(Date.now() - 60_000).toISOString();
  const expireLease = (taskId: string) =>
    driver.executeQuery(
      "MATCH (:Agent)-[r:CLAIMED_BY]->(:Task {id: $taskId}) SET r.leaseExpiresAt = $expired",
      { taskId, expired },
    );

  console.log("Crash recovery: an abandoned claim must not wedge the board.\n");

  const { taskId } = await call<{ taskId: string }>("add_task", {
    title: "LEASE-TEST: recover me after my agent dies",
  });

  const first = await call<ClaimResult>("claim_task", { task_id: taskId, agent_id: "agent-a" });
  check("agent-a claims the task", first.ok, JSON.stringify(first));

  const blocked = await call<ClaimResult>("claim_task", { task_id: taskId, agent_id: "agent-b" });
  check(
    "agent-b is refused while agent-a's lease is live",
    !blocked.ok && blocked.reason === "already claimed" && blocked.claimedBy === "agent-a",
    JSON.stringify(blocked),
  );

  await expireLease(taskId);
  console.log(`\n     agent-a crashes; its lease is now expired (${expired})\n`);

  const stolen = await call<ClaimResult>("claim_task", { task_id: taskId, agent_id: "agent-b" });
  check("agent-b takes over the abandoned claim", stolen.ok, JSON.stringify(stolen));

  const edges = await driver.executeQuery(
    `
    MATCH (:Task {id: $taskId})<-[r:CLAIMED_BY]-(a:Agent)
    RETURN count(r) AS n, collect(a.id) AS holders
    `,
    { taskId },
  );
  const held = edges.records[0].toObject() as { n: unknown; holders: string[] };
  check(
    "the stale edge was replaced, not stacked on",
    Number(held.n) === 1 && held.holders[0] === "agent-b",
    `${String(held.n)} edge(s) held by ${held.holders.join(", ") || "nobody"}`,
  );

  const events = await call<EventView[]>("list_events");
  const theft = events.find((e) => e.taskId === taskId && e.type === "claim_stolen");
  check("the feed records a claim_stolen event", !!theft, "none in the last 100 events");
  if (theft) console.log(`     ${theft.message}`);

  const { taskId: contested } = await call<{ taskId: string }>("add_task", {
    title: "LEASE-TEST: two thieves, one winner",
  });
  await call("claim_task", { task_id: contested, agent_id: "agent-a" });
  await expireLease(contested);

  const thieves = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      call<ClaimResult>("claim_task", {
        task_id: contested,
        agent_id: i % 2 === 0 ? "agent-a" : "agent-b",
      }),
    ),
  );
  const winners = thieves.filter((t) => t.ok);
  check(
    "racing for an expired lease still yields exactly one winner",
    winners.length === 1,
    `${winners.length} winners`,
  );
  await call("release_task", {
    task_id: contested,
    agent_id: winners[0]?.agentId ?? "agent-b",
  });

  await call("update_task", {
    task_id: taskId,
    status: "done",
    result: "finished after takeover",
    agent_id: "agent-b",
  });
  await call("release_task", { task_id: taskId, agent_id: "agent-b" });
  const onDone = await call<ClaimResult>("claim_task", { task_id: taskId, agent_id: "agent-a" });
  check("a finished task cannot be claimed again", !onDone.ok, JSON.stringify(onDone));

  console.log(
    failures === 0
      ? "\nPASS — an abandoned claim is recoverable, and recovery is still race-safe"
      : `\nFAIL — ${failures} faulty checks`,
  );
  await driver.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await driver.close();
  process.exit(1);
});
