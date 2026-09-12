import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { optional } from "./env.js";
import { checkConnection, driver, initSchema } from "./db.js";
import {
  addTask,
  claimTask,
  listAgents,
  listEvents,
  listTasks,
  releaseTask,
  TASK_STATUSES,
  updateTask,
} from "./queries.js";

const PORT = Number(optional("MCP_PORT", "3333"));

function buildServer(): McpServer {
  const server = new McpServer({ name: "shared-task-board", version: "0.1.0" });

  const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });

  server.tool(
    "list_tasks",
    "List all tasks on the shared board with their status and current claimant.",
    {},
    async () => json(await listTasks()),
  );

  server.tool(
    "claim_task",
    "Atomically claim a task for an agent. Fails (ok:false) if the task does not exist, the agent is unknown, or another agent already holds the claim.",
    { task_id: z.string(), agent_id: z.string() },
    async ({ task_id, agent_id }) => json(await claimTask(task_id, agent_id)),
  );

  server.tool(
    "release_task",
    "Release a task's claim (returns it to the pool). Used by agents when done and by humans as an override.",
    { task_id: z.string(), agent_id: z.string().optional() },
    async ({ task_id, agent_id }) => json(await releaseTask(task_id, agent_id ?? "human")),
  );

  server.tool(
    "update_task",
    "Update a task's status (todo | in_progress | done), optionally attaching a result.",
    {
      task_id: z.string(),
      status: z.enum(TASK_STATUSES),
      result: z.string().optional(),
      agent_id: z.string().optional(),
    },
    async ({ task_id, status, result, agent_id }) =>
      json(await updateTask(task_id, status, result ?? null, agent_id ?? "human")),
  );

  server.tool(
    "add_task",
    "Add a new task to the shared board.",
    { title: z.string(), agent_id: z.string().optional() },
    async ({ title, agent_id }) => json(await addTask(title, agent_id ?? "human")),
  );

  server.tool(
    "list_events",
    "Recent board activity (claims, releases, updates), newest first.",
    {},
    async () => json(await listEvents()),
  );

  return server;
}

async function main() {
  console.log("boot: starting, checking Neo4j connection…");
  await checkConnection();
  console.log("boot: Neo4j connected, initializing schema…");
  await initSchema();
  console.log("boot: schema ready, starting express…");

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, server: "shared-task-board" });
  });

  // Stateless Streamable HTTP: one MCP server instance per request, no sessions.
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.get("/mcp", (_req, res) =>
    res.status(405).json({ error: "Stateless server — POST only" }),
  );
  app.delete("/mcp", (_req, res) =>
    res.status(405).json({ error: "Stateless server — POST only" }),
  );

  app.listen(PORT, () => {
    console.log(`MCP server listening on http://localhost:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await driver.close();
  process.exit(0);
});
