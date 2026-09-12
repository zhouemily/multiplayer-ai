import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface TaskView {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "done";
  claimedBy: string | null;
  result: string | null;
}

export class BoardClient {
  private client: Client;

  constructor(private mcpUrl: string, private name: string) {
    this.client = new Client({ name, version: "0.1.0" });
  }

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
    await this.client.connect(transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === "text",
    )?.text;
    if (!text) throw new Error(`Tool ${name} returned no text content`);
    return JSON.parse(text) as T;
  }

  listTasks(): Promise<TaskView[]> {
    return this.call<TaskView[]>("list_tasks");
  }

  claimTask(taskId: string, agentId: string) {
    return this.call<{ ok: boolean; taskId: string; claimedBy?: string; reason?: string }>(
      "claim_task",
      { task_id: taskId, agent_id: agentId },
    );
  }

  updateTask(taskId: string, status: string, result: string, agentId: string) {
    return this.call<{ ok: boolean }>("update_task", {
      task_id: taskId,
      status,
      result,
      agent_id: agentId,
    });
  }

  releaseTask(taskId: string, agentId: string) {
    return this.call<{ ok: boolean; released: boolean }>("release_task", {
      task_id: taskId,
      agent_id: agentId,
    });
  }
}
