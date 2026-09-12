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
  status: "todo" | "awaiting" | "in_progress" | "done" | "blocked";
  claimedBy: string | null;
  /** ISO-8601 UTC; null when unclaimed. Past this instant the claim is stealable. */
  leaseExpiresAt: string | null;
  result: string | null;
  /** Pipeline position. Null for standalone board tasks. */
  step: "design" | "design_review" | "execute" | "execute_review" | "done" | null;
  attempt: number | null;
  maxAttempts: number | null;
  projectId: string | null;
}

export interface ProjectView {
  id: string;
  goal: string;
  status: string;
  /** Subtask ids in the order the manager laid them out. */
  subtaskIds: string[];
}

export interface AgentView {
  id: string;
  name: string;
  role: string | null;
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
  projects: ProjectView[];
  events: EventView[];
}> {
  const tasksResult = await driver.executeQuery(
    `
    MATCH (t:Task)
    OPTIONAL MATCH (a:Agent)-[r:CLAIMED_BY]->(t)
    OPTIONAL MATCH (p:Project)-[:HAS_SUBTASK]->(t)
    RETURN t.id AS id, t.title AS title, t.status AS status,
           t.result AS result, t.createdAt AS createdAt,
           t.step AS step, t.attempt AS attempt, t.maxAttempts AS maxAttempts,
           p.id AS projectId,
           a.id AS claimedBy, r.leaseExpiresAt AS leaseExpiresAt
    ORDER BY t.createdAt ASC, t.id ASC
    `,
  );
  const projectsResult = await driver.executeQuery(
    `
    MATCH (p:Project)
    OPTIONAL MATCH (p)-[h:HAS_SUBTASK]->(t:Task)
    WITH p, t, h ORDER BY h.order ASC
    RETURN p.id AS id, p.goal AS goal, p.status AS status,
           collect(t.id) AS subtaskIds, p.createdAt AS createdAt
    ORDER BY p.createdAt DESC
    `,
  );
  const agentsResult = await driver.executeQuery(
    `
    MATCH (a:Agent)
    OPTIONAL MATCH (a)-[:CLAIMED_BY]->(t:Task)
    RETURN a.id AS id, a.name AS name, a.role AS role, collect(t.id) AS claimedTaskIds
    ORDER BY a.id ASC
    `,
  );
  const eventsResult = await driver.executeQuery(
    "MATCH (e:Event) RETURN e ORDER BY e.seq DESC LIMIT 100",
  );

  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

  return {
    tasks: tasksResult.records.map((r) => {
      const row = r.toObject() as TaskView;
      return { ...row, attempt: num(row.attempt), maxAttempts: num(row.maxAttempts) };
    }),
    projects: projectsResult.records.map((r) => {
      const row = r.toObject() as ProjectView & { subtaskIds: (string | null)[] };
      return {
        id: row.id,
        goal: row.goal,
        status: row.status,
        subtaskIds: row.subtaskIds.filter((id): id is string => id !== null),
      };
    }),
    agents: agentsResult.records.map((r) => {
      const row = r.toObject() as {
        id: string;
        name: string;
        role: string | null;
        claimedTaskIds: (string | null)[];
      };
      return {
        id: row.id,
        name: row.name,
        role: row.role,
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
