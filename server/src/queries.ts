import { driver } from "./db.js";

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  claimedBy: string | null;
  result: string | null;
  createdAt: string;
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

const iso = () => new Date().toISOString();

export async function listTasks(): Promise<TaskView[]> {
  const result = await driver.executeQuery(
    `
    MATCH (t:Task)
    OPTIONAL MATCH (a:Agent)-[:CLAIMED_BY]->(t)
    RETURN t.id AS id, t.title AS title, t.status AS status,
           t.result AS result, t.createdAt AS createdAt,
           a.id AS claimedBy
    ORDER BY t.createdAt ASC, t.id ASC
    `,
  );
  return result.records.map((r) => r.toObject() as TaskView);
}

export async function listAgents(): Promise<AgentView[]> {
  const result = await driver.executeQuery(
    `
    MATCH (a:Agent)
    OPTIONAL MATCH (a)-[:CLAIMED_BY]->(t:Task)
    RETURN a.id AS id, a.name AS name, collect(t.id) AS claimedTaskIds
    ORDER BY a.id ASC
    `,
  );
  return result.records.map((r) => {
    const row = r.toObject() as { id: string; name: string; claimedTaskIds: (string | null)[] };
    return {
      id: row.id,
      name: row.name,
      claimedTaskIds: row.claimedTaskIds.filter((id) => id !== null),
    };
  });
}

export async function listEvents(limit = 100): Promise<EventView[]> {
  const result = await driver.executeQuery(
    "MATCH (e:Event) RETURN e ORDER BY e.seq DESC LIMIT $limit",
    { limit },
  );
  return result.records.map((r) => {
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
  });
}

/**
 * Race-safe claim. The uniqueness constraint on CLAIMED_BY.token (always the
 * task id) makes this an atomic test-and-set: if two agents race for the same
 * task, the database rejects the second edge and its whole transaction rolls
 * back — including the event, so a claim and its feed entry can never diverge.
 */
export async function claimTask(taskId: string, agentId: string) {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (t:Task {id: $taskId})
      MATCH (a:Agent {id: $agentId})
      CREATE (a)-[:CLAIMED_BY {token: t.id, claimedAt: $now}]->(t)
      SET t.status = 'in_progress', t.updatedAt = $now
      WITH t, a
      MATCH (c:Counter {name: 'events'})
      SET c.seq = c.seq + 1
      WITH c, t, a
      CREATE (e:Event {
        id: randomUUID(), seq: c.seq, type: 'claim_won', agentId: a.id, taskId: t.id,
        message: a.name + ' claimed ' + t.id + ' — "' + t.title + '"', at: $now
      })
      RETURN t.id AS taskId
      `,
      { taskId, agentId, now: iso() },
    );
    if (result.records.length === 0) {
      return { ok: false as const, taskId, agentId, reason: "task or agent not found" };
    }
    return { ok: true as const, taskId, agentId };
  } catch (err) {
    if (String((err as { code?: string }).code).includes("ConstraintValidationFailed")) {
      const holder = await currentHolder(taskId);
      await logEvent(
        "claim_lost",
        agentId,
        taskId,
        `${agentId} tried to claim ${taskId} but ${holder ?? "another agent"} already holds it`,
      );
      return { ok: false as const, taskId, agentId, reason: "already claimed", claimedBy: holder };
    }
    throw err;
  } finally {
    await session.close();
  }
}

async function currentHolder(taskId: string): Promise<string | null> {
  const result = await driver.executeQuery(
    "MATCH (:Task {id: $taskId})<-[:CLAIMED_BY]-(a:Agent) RETURN a.id AS id",
    { taskId },
  );
  return result.records[0]?.get("id") ?? null;
}

export async function releaseTask(taskId: string, actorId: string) {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (t:Task {id: $taskId})<-[r:CLAIMED_BY]-(a:Agent)
      DELETE r
      SET t.status = CASE t.status WHEN 'in_progress' THEN 'todo' ELSE t.status END,
          t.updatedAt = $now
      WITH t, a
      MATCH (c:Counter {name: 'events'})
      SET c.seq = c.seq + 1
      WITH c, t, a
      CREATE (e:Event {
        id: randomUUID(), seq: c.seq, type: 'task_released', agentId: $actorId, taskId: t.id,
        message: $actorId + ' released ' + t.id + ' (was held by ' + a.id + ')', at: $now
      })
      RETURN t.id AS taskId, a.id AS previousHolder
      `,
      { taskId, actorId, now: iso() },
    );
    if (result.records.length === 0) {
      const exists = await driver.executeQuery("MATCH (t:Task {id: $taskId}) RETURN t.id", { taskId });
      if (exists.records.length === 0) {
        return { ok: false as const, taskId, released: false, reason: "task not found" };
      }
      return { ok: true as const, taskId, released: false, reason: "not currently claimed" };
    }
    return {
      ok: true as const,
      taskId,
      released: true,
      previousHolder: result.records[0].get("previousHolder"),
    };
  } finally {
    await session.close();
  }
}

export async function updateTask(
  taskId: string,
  status: TaskStatus,
  result: string | null,
  actorId: string,
) {
  const props: Record<string, unknown> = { status, updatedAt: iso() };
  if (result !== null) props.result = result;
  const session = driver.session();
  try {
    const res = await session.run(
      `
      MATCH (t:Task {id: $taskId})
      SET t += $props
      WITH t
      MATCH (c:Counter {name: 'events'})
      SET c.seq = c.seq + 1
      WITH c, t
      CREATE (e:Event {
        id: randomUUID(), seq: c.seq, type: 'task_updated', agentId: $actorId, taskId: t.id,
        message: $actorId + ' set ' + t.id + ' → ' + $status + ' — "' + t.title + '"', at: $now
      })
      RETURN t.id AS taskId
      `,
      { taskId, props, actorId, status, now: iso() },
    );
    if (res.records.length === 0) return { ok: false as const, taskId, reason: "task not found" };
    return { ok: true as const, taskId, status };
  } finally {
    await session.close();
  }
}

export async function addTask(title: string, actorId: string) {
  const id = "T-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const session = driver.session();
  try {
    await session.run(
      `
      CREATE (t:Task {id: $id, title: $title, status: 'todo', createdAt: $now, updatedAt: $now})
      WITH t
      MATCH (c:Counter {name: 'events'})
      SET c.seq = c.seq + 1
      WITH c, t
      CREATE (e:Event {
        id: randomUUID(), seq: c.seq, type: 'task_added', agentId: $actorId, taskId: t.id,
        message: $actorId + ' added ' + $id + ' — "' + $title + '"', at: $now
      })
      `,
      { id, title, actorId, now: iso() },
    );
    return { ok: true as const, taskId: id, title };
  } finally {
    await session.close();
  }
}

export async function logEvent(
  type: string,
  agentId: string,
  taskId: string,
  message: string,
): Promise<void> {
  await driver.executeQuery(
    `
    MATCH (c:Counter {name: 'events'})
    SET c.seq = c.seq + 1
    WITH c
    CREATE (e:Event {
      id: randomUUID(), seq: c.seq, type: $type, agentId: $agentId, taskId: $taskId,
      message: $message, at: $now
    })
    `,
    { type, agentId, taskId, message, now: iso() },
  );
}
