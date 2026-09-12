import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class McpClient {
  private client: Client;

  constructor(private mcpUrl: string) {
    this.client = new Client({ name: "human-monitor", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
    await this.client.connect(transport);
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === "text",
    )?.text;
    if (!text) throw new Error(`Tool ${name} returned no text content`);
    return JSON.parse(text) as T;
  }

  releaseTask(taskId: string) {
    return this.call<{ ok: boolean; released: boolean }>("release_task", {
      task_id: taskId,
      agent_id: "human",
    });
  }

  addTask(title: string) {
    return this.call<{ ok: boolean; taskId: string }>("add_task", { title });
  }
}
