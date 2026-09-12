import neo4j from "neo4j-driver";
import { required } from "./env.js";

export const driver = neo4j.driver(
  required("NEO4J_URI"),
  neo4j.auth.basic(
    process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "neo4j",
    required("NEO4J_PASSWORD"),
  ),
  { connectionTimeout: 20_000, maxConnectionPoolSize: 6 },
);

export interface TaskView {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "done";
  claimedBy: string | null;
  result: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  claimedTaskIds: string[];
}

export interface EventView {
  id: string;
  seq: number;
  type: string;
  agentId: string;
  taskId: string;
  message: string;
  at: string;
}

export async function readState(): Promise<{
  agents: AgentView[];
  tasks: TaskView[];
  events: EventView[];
}> {
  const tasksResult = await driver.executeQuery(
    `
    MATCH (t:Task)
    OPTIONAL MATCH (a:Agent)-[:CLAIMED_BY]->(t)
    RETURN t.id AS id, t.title AS title, t.status AS status,
           t.result AS result, t.createdAt AS createdAt, a.id AS claimedBy
    ORDER BY t.createdAt ASC, t.id ASC
    `,
  );
  const agentsResult = await driver.executeQuery(
    `
    MATCH (a:Agent)
    OPTIONAL MATCH (a)-[:CLAIMED_BY]->(t:Task)
    RETURN a.id AS id, a.name AS name, collect(t.id) AS claimedTaskIds
    ORDER BY a.id ASC
    `,
  );
  const eventsResult = await driver.executeQuery(
    "MATCH (e:Event) RETURN e ORDER BY e.seq DESC LIMIT 100",
  );

  return {
    tasks: tasksResult.records.map((r) => r.toObject() as TaskView),
    agents: agentsResult.records.map((r) => {
      const row = r.toObject() as { id: string; name: string; claimedTaskIds: (string | null)[] };
      return {
        id: row.id,
        name: row.name,
        claimedTaskIds: row.claimedTaskIds.filter((id) => id !== null),
      };
    }),
    events: eventsResult.records.map((r) => {
      const e = r.get("e").properties;
      return {
        id: e.id,
        seq: Number(e.seq),
        type: e.type,
        agentId: e.agentId,
        taskId: e.taskId,
        message: e.message,
        at: e.at,
      };
    }),
  };
}
