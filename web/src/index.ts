import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { optional } from "./env.js";
import { driver, readState } from "./db.js";
import { McpClient } from "./mcp.js";

const PORT = Number(optional("WEB_PORT", "3334"));
const MCP_URL = optional("MCP_URL", "http://localhost:3333/mcp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await driver.verifyConnectivity();

  // The human goes through the same MCP tool contract as the agents.
  const mcp = new McpClient(MCP_URL);
  await mcp.connect();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../public")));

  app.get("/api/state", async (_req, res) => {
    try {
      const state = await readState();
      res.json({ ...state, serverTime: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/release", async (req, res) => {
    try {
      const { taskId } = req.body as { taskId?: string };
      if (!taskId) {
        res.status(400).json({ error: "taskId required" });
        return;
      }
      res.json(await mcp.releaseTask(taskId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    try {
      const { title } = req.body as { title?: string };
      if (!title?.trim()) {
        res.status(400).json({ error: "title required" });
        return;
      }
      res.json(await mcp.addTask(title.trim()));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.listen(PORT, () => {
    console.log(`Monitor UI on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
