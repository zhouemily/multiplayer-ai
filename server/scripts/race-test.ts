import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { optional, required } from "../src/env.js";

const MCP_URL = optional("MCP_URL", `http://localhost:${optional("MCP_PORT", "3333")}/mcp`);
const ROUNDS = Number(optional("RACE_ROUNDS", "10"));
const CONCURRENCY = Number(optional("RACE_CONCURRENCY", "8"));

void required("NEO4J_URI"); // just fail fast with a clear message if .env is missing

interface ClaimResult {
  ok: boolean;
  taskId: string;
  agentId?: string;
  claimedBy?: string;
  reason?: string;
}

async function main() {
  const client = new Client({ name: "race-test", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === "text",
    )?.text;
    if (!text) throw new Error(`Tool ${name} returned no text`);
    return JSON.parse(text) as T;
  };

  const added = await call<{ ok: boolean; taskId: string }>("add_task", {
    title: "RACE-TEST: only one agent may claim me",
  });
  const taskId = added.taskId;
  console.log(`Race test target: ${taskId} (${ROUNDS} rounds, ${CONCURRENCY} concurrent claims each)`);

  let failures = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    const attempts = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        call<ClaimResult>("claim_task", {
          task_id: taskId,
          agent_id: i % 2 === 0 ? "agent-a" : "agent-b",
        }),
      ),
    );

    const winners = attempts.filter((a) => a.ok);
    const losers = attempts.filter((a) => !a.ok);

    const loserReasonsOk = losers.every(
      (l) => l.reason === "already claimed" && typeof l.claimedBy === "string",
    );

    if (winners.length !== 1 || !loserReasonsOk) {
      failures++;
      console.error(
        `round ${round}: FAIL — ${winners.length} winners (expected 1), losers reasons ok: ${loserReasonsOk}`,
      );
    } else {
      console.log(
        `round ${round}: ok — winner=${winners[0].agentId}, ` +
          `${losers.length} losers correctly rejected`,
      );
    }

    await call("update_task", {
      task_id: taskId,
      status: "done",
      agent_id: winners[0].agentId ?? "agent-a",
    });
    const release = await call<{ ok: boolean; released: boolean }>("release_task", { task_id: taskId });
    if (!release.released) {
      failures++;
      console.error(`round ${round}: FAIL — could not release after claiming`);
    }
    // claim_task refuses done tasks, so put it back in the pool for the next round.
    await call("update_task", { task_id: taskId, status: "todo", agent_id: "race-test" });
  }

  await call("release_task", { task_id: taskId });
  console.log(
    failures === 0
      ? `\nPASS — ${ROUNDS} rounds, ${ROUNDS * CONCURRENCY} claim attempts, zero double-claims`
      : `\nFAIL — ${failures} faulty rounds`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
