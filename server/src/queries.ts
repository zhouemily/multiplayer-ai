import { int } from "neo4j-driver";
import { driver, LEASE_MINUTES } from "./db.js";

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  claimedBy: string | null;
  /** ISO-8601 UTC; null when unclaimed. Past this instant the claim is stealable. */
  leaseExpiresAt: string | null;
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
    OPTIONAL MATCH (a:Agent)-[r:CLAIMED_BY]->(t)
    RETURN t.id AS id, t.title AS title, t.status AS status,
           t.result AS result, t.createdAt AS createdAt,
           a.id AS claimedBy, r.leaseExpiresAt AS leaseExpiresAt
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
    { limit: int(limit) },
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
 *
 * Expired leases are deleted by the same statement, so a crashed agent cannot
 * wedge a task: the next claim simply takes it over, still constraint-arbitrated.
 */
export async function claimTask(taskId: string, agentId: string) {
  const now = iso();
  const leaseUntil = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString();
  const session = driver.session();
  try {
    const records = await session.executeWrite(async (tx) => {
      const result = await tx.run(
        `
        MATCH (t:Task {id: $taskId})
        MATCH (a:Agent {id: $agentId})
        WHERE t.status <> 'done'
        OPTIONAL MATCH (prev:Agent)-[stale:CLAIMED_BY]->(t)
        WHERE stale.leaseExpiresAt <= $now OR stale.leaseExpiresAt IS NULL
        WITH t, a, collect(stale) AS expired, collect(prev.id) AS prevHolders
        FOREACH (s IN expired | DELETE s)
        CREATE (a)-[:CLAIMED_BY {token: t.id, claimedAt: $now, leaseExpiresAt: $leaseUntil}]->(t)
        SET t.status = 'in_progress', t.updatedAt = $now
        WITH t, a, size(expired) AS takeover, prevHolders
        MATCH (c:Counter {name: 'events'})
        SET c.seq = c.seq + 1
        CREATE (e:Event {
          id: randomUUID(), seq: c.seq, agentId: a.id, taskId: t.id,
          type: CASE WHEN takeover > 0 THEN 'claim_stolen' ELSE 'claim_won' END,
          message: CASE WHEN takeover > 0
                        THEN a.name + ' took over ' + t.id + ' — lease held by ' +
                             coalesce(prevHolders[0], 'an unknown agent') + ' expired'
                        ELSE a.name + ' claimed ' + t.id + ' — "' + t.title + '"' END,
          at: $now
        })
        RETURN t.id AS taskId
        `,
        { taskId, agentId, now, leaseUntil },
      );
      return (await result).records;
    });
    if (records.length === 0) {
      return { ok: false as const, taskId, agentId, reason: "task unavailable" };
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
  const now = iso();
  const session = driver.session();
  try {
    const records = await session.executeWrite(async (tx) => {
      const result = await tx.run(
        `
        MATCH (t:Task {id: $taskId})<-[r:CLAIMED_BY]-(a:Agent)
        DELETE r
        SET t.status = CASE t.status WHEN 'in_progress' THEN 'todo' ELSE t.status END,
            t.updatedAt = $now
        WITH t, a
        MATCH (c:Counter {name: 'events'})
        SET c.seq = c.seq + 1
        CREATE (e:Event {
          id: randomUUID(), seq: c.seq, type: 'task_released', agentId: $actorId, taskId: t.id,
          message: $actorId + ' released ' + t.id + ' (was held by ' + a.id + ')', at: $now
        })
        RETURN t.id AS taskId, a.id AS previousHolder
        `,
        { taskId, actorId, now },
      );
      return (await result).records;
    });
    if (records.length === 0) {
      const exists = await driver.executeQuery("MATCH (t:Task {id: $taskId}) RETURN t.id", { taskId });
      if (exists.records.length === 0) {
        return { ok: false as const, taskId, released: false, reason: "task not found" };
      }
      return { ok: true as const, taskId, released: false, reason: "not currently claimed" };
    }
    return { ok: true as const, taskId, released: true, previousHolder: records[0].get("previousHolder") };
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
  const now = iso();
  const props: Record<string, unknown> = { status, updatedAt: now };
  if (result !== null) props.result = result;
  const session = driver.session();
  try {
    const records = await session.executeWrite(async (tx) => {
      const res = await tx.run(
        `
        MATCH (t:Task {id: $taskId})
        SET t += $props
        WITH t
        MATCH (c:Counter {name: 'events'})
        SET c.seq = c.seq + 1
        CREATE (e:Event {
          id: randomUUID(), seq: c.seq, type: 'task_updated', agentId: $actorId, taskId: t.id,
          message: $actorId + ' set ' + t.id + ' → ' + $status + ' — "' + t.title + '"', at: $now
        })
        RETURN t.id AS taskId
        `,
        { taskId, props, actorId, status, now },
      );
      return (await res).records;
    });
    if (records.length === 0) return { ok: false as const, taskId, reason: "task not found" };
    return { ok: true as const, taskId, status };
  } finally {
    await session.close();
  }
}

export async function addTask(title: string, actorId: string) {
  const id = "T-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const now = iso();
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `
        CREATE (t:Task {id: $id, title: $title, status: 'todo', createdAt: $now, updatedAt: $now})
        WITH t
        MATCH (c:Counter {name: 'events'})
        SET c.seq = c.seq + 1
        CREATE (e:Event {
          id: randomUUID(), seq: c.seq, type: 'task_added', agentId: $actorId, taskId: t.id,
          message: $actorId + ' added ' + $id + ' — "' + $title + '"', at: $now
        })
        `,
        { id, title, actorId, now },
      );
    });
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
