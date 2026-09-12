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
import {
  isProjectSubtask,
  nextAssignment,
  planProject,
  projectStatus,
  recall,
  remember,
  startProject,
  submitReview,
  submitStep,
} from "./orchestrator.js";

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
    "Atomically claim a standalone board task for an agent. Fails (ok:false) if the task does not exist, is already done, the agent is unknown, or another agent holds a live claim. A claim carries a lease; once it expires the task becomes claimable again and this tool takes it over, so a crashed agent cannot wedge the board. Project subtasks are not claimable here — use next_assignment.",
    { task_id: z.string(), agent_id: z.string() },
    async ({ task_id, agent_id }) => {
      if (await isProjectSubtask(task_id)) {
        return json({
          ok: false,
          taskId: task_id,
          reason:
            "that is a project subtask — call next_assignment instead, which hands you the step " +
            "you are allowed to do and claims it for you",
        });
      }
      return json(await claimTask(task_id, agent_id));
    },
  );

  server.tool(
    "release_task",
    "Release a task's claim (returns it to the pool). Used by agents when done and by humans as an override.",
    { task_id: z.string(), agent_id: z.string().optional() },
    async ({ task_id, agent_id }) => json(await releaseTask(task_id, agent_id ?? "human")),
  );

  server.tool(
    "update_task",
    "Update a standalone board task's status (todo | in_progress | done), optionally attaching a result. Project subtasks cannot be set by hand — they advance through submit_step and submit_review.",
    {
      task_id: z.string(),
      status: z.enum(TASK_STATUSES),
      result: z.string().optional(),
      agent_id: z.string().optional(),
    },
    async ({ task_id, status, result, agent_id }) => {
      if (await isProjectSubtask(task_id)) {
        return json({
          ok: false,
          taskId: task_id,
          reason:
            "that is a project subtask — its status is set by the pipeline. Use submit_step to " +
            "finish design or execute work, or submit_review to pass or fail a review",
        });
      }
      return json(await updateTask(task_id, status, result ?? null, agent_id ?? "human"));
    },
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

  server.tool(
    "start_project",
    "START HERE. Turn a user's goal into a managed project. Returns your manager playbook and " +
      "the briefing text to hand each subagent you spawn. You become the manager: you decompose " +
      "and monitor, but never do the work — the server refuses manager claims.",
    { goal: z.string(), agent_id: z.string().optional() },
    async ({ goal, agent_id }) => json(await startProject(goal, agent_id ?? "manager")),
  );

  server.tool(
    "plan_project",
    "Submit your decomposition: 2-6 independent subtask titles. Each becomes a subtask running " +
      "design → design_review → execute → execute_review.",
    {
      project_id: z.string(),
      subtasks: z.array(z.string()).min(1),
      agent_id: z.string().optional(),
    },
    async ({ project_id, subtasks, agent_id }) =>
      json(await planProject(project_id, subtasks, agent_id ?? "manager")),
  );

  server.tool(
    "next_assignment",
    "The only call a worker needs. Returns one step to do, with the goal, the approved design, " +
      "any failed-review feedback, and the subtask's accumulated memory. Omit agent_id on your " +
      "first call and the server mints your identity — reuse the returned agent_id afterwards. " +
      "You will never be assigned a review of your own work. Pass project_id to only pull steps " +
      "from the project you were spawned for.",
    {
      agent_id: z.string().optional(),
      nickname: z.string().optional(),
      project_id: z.string().optional(),
    },
    async ({ agent_id, nickname, project_id }) =>
      json(await nextAssignment(agent_id, nickname, project_id)),
  );

  server.tool(
    "submit_step",
    "Finish a design or execute step you hold. `output` is the plan (design) or an account of " +
      "what you changed and how you verified it (execute). Sends the subtask to review by a " +
      "different agent.",
    { subtask_id: z.string(), agent_id: z.string(), output: z.string() },
    async ({ subtask_id, agent_id, output }) =>
      json(await submitStep(subtask_id, agent_id, output)),
  );

  server.tool(
    "submit_review",
    "Finish a review step you hold. 'pass' advances the pipeline; 'fail' sends the work back with " +
      "your feedback and burns an attempt, and feedback is required. Once attempts run out the " +
      "subtask is blocked for the manager.",
    {
      subtask_id: z.string(),
      agent_id: z.string(),
      verdict: z.enum(["pass", "fail"]),
      feedback: z.string().default(""),
    },
    async ({ subtask_id, agent_id, verdict, feedback }) =>
      json(await submitReview(subtask_id, agent_id, verdict, feedback)),
  );

  server.tool(
    "remember",
    "Save context for whoever works this next. Pass subtask_id for task-specific notes (the next " +
      "agent on that subtask reads them), or project_id for manager-level notes about what was " +
      "decomposed, tried, and finished.",
    {
      text: z.string(),
      agent_id: z.string(),
      subtask_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    async ({ text, agent_id, subtask_id, project_id }) =>
      json(await remember(text, agent_id, { subtaskId: subtask_id, projectId: project_id })),
  );

  server.tool(
    "recall",
    "Read saved memory for a subtask or project, oldest first. Filter by author_id to see what a " +
      "particular agent recorded.",
    {
      subtask_id: z.string().optional(),
      project_id: z.string().optional(),
      author_id: z.string().optional(),
    },
    async ({ subtask_id, project_id, author_id }) =>
      json(
        await recall({ subtaskId: subtask_id, projectId: project_id, authorId: author_id }),
      ),
  );

  server.tool(
    "project_status",
    "Manager's view: every subtask's step, attempt count, current holder, and who performed what. " +
      "`needsManager` lists subtasks that ran out of review attempts.",
    { project_id: z.string().optional() },
    async ({ project_id }) => json(await projectStatus(project_id)),
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
