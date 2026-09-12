import { int } from "neo4j-driver";
import { DEFAULT_MAX_ATTEMPTS, driver } from "./db.js";
import {
  AFTER_FAIL,
  AFTER_PASS,
  AFTER_WORK,
  claimTask,
  REVIEW_STEPS,
  StepName,
  TERMINAL_STATUSES,
  WORK_STEPS,
} from "./queries.js";

const iso = () => new Date().toISOString();
const shortId = () => Math.random().toString(36).slice(2, 6).toUpperCase();

export type Verdict = "pass" | "fail";

export interface MemoryNote {
  seq: number;
  text: string;
  authorId: string;
  at: string;
}

export interface StepRecord {
  agentId: string;
  step: string;
  attempt: number;
  at: string;
}

export interface SubtaskStatus {
  id: string;
  title: string;
  status: string;
  step: string;
  attempt: number;
  maxAttempts: number;
  claimedBy: string | null;
  lastFeedback: string | null;
  /** "agent-id:step" pairs — the audit trail behind the reviewer guard. */
  performed: string[];
}

/**
 * What each role is expected to produce. Returned verbatim inside an assignment
 * so a freshly spawned subagent needs no configuration to know its job.
 */
const STEP_BRIEF: Record<string, string> = {
  design:
    "DESIGN this subtask. Do not implement it. Produce a short plan: the approach, " +
    "the files or components involved, and how a reviewer can tell it worked. " +
    "Call submit_step with that plan as `output`.",
  design_review:
    "REVIEW the design below — you did not write it. Judge only whether it is a sound, " +
    "specific plan that satisfies the subtask. Call submit_review with verdict 'pass', or " +
    "'fail' plus concrete feedback naming what to change. Vague approval is worse than a fail.",
  execute:
    "EXECUTE the approved design below. Use your own tools to do the real work, then call " +
    "submit_step with `output` describing what you actually changed and how you verified it.",
  execute_review:
    "REVIEW the execution below — you did not perform it. Check it against the approved design " +
    "and the subtask. Call submit_review with verdict 'pass', or 'fail' plus concrete feedback.",
};

export const MANAGER_PLAYBOOK = [
  "You are the MANAGER of this project. You do not do the work yourself — the server will",
  "refuse your claims if you try.",
  "",
  "1. Break the goal into 2-6 independent subtasks and call plan_project with their titles.",
  "2. Spawn one subagent per subtask using your own subagent/Task tool, in parallel. Give each",
  "   the WORKER_BRIEFING text returned alongside this playbook, verbatim.",
  "3. Each subtask runs design -> design_review -> execute -> execute_review. The server hands",
  "   out those steps; a failed review sends the work back with feedback and bumps the attempt.",
  "4. A reviewer may never be the agent who did the step under review, so keep at least two",
  "   workers alive per subtask. Spawning more workers than subtasks is fine and speeds reviews.",
  "5. Poll project_status. When a subtask reaches status 'blocked' it exhausted its attempts and",
  "   needs you: re-scope it with plan_project, or escalate to the human.",
  "6. Record decomposition rationale and outcomes with remember(project_id=...). That project",
  "   memory is what a future manager reads to learn what was already tried and by whom.",
].join("\n");

export const WORKER_BRIEFING = [
  "You are a worker on a shared task board. Do this loop:",
  "",
  "1. Call next_assignment (no agent_id the first time — the server mints your identity and",
  "   returns it; reuse that agent_id on every later call).",
  "2. Do exactly the step you are handed, then call submit_step or submit_review as instructed.",
  "3. Anything the next agent on this subtask would need to know, save with",
  "   remember(subtask_id=...). Anything you needed and had to work out yourself was probably",
  "   missing from that memory — add it.",
  "4. Loop back to next_assignment until it reports no work available, then stop and summarise.",
  "",
  "You hold a lease on each assignment. If you stall, it expires and another worker takes over,",
  "so submit promptly or release it.",
].join("\n");

async function ensureAgent(id: string, name: string, role: "manager" | "worker"): Promise<void> {
  await driver.executeQuery(
    `MERGE (a:Agent {id: $id})
     ON CREATE SET a.name = $name, a.role = $role
     ON MATCH SET a.role = coalesce(a.role, $role)`,
    { id, name, role },
  );
}

async function agentRole(id: string): Promise<string | null> {
  const res = await driver.executeQuery("MATCH (a:Agent {id: $id}) RETURN a.role AS role", { id });
  return res.records[0]?.get("role") ?? null;
}

export async function startProject(goal: string, managerId = "manager") {
  const id = "P-" + shortId();
  const now = iso();
  await ensureAgent(managerId, "Manager", "manager");
  await driver.executeQuery(
    `
    CREATE (p:Project {id: $id, goal: $goal, status: 'planning', createdAt: $now, updatedAt: $now})
    WITH p
    MATCH (c:Counter {name: 'events'})
    SET c.seq = c.seq + 1
    CREATE (:Event {
      id: randomUUID(), seq: c.seq, type: 'project_started', agentId: $managerId, taskId: $id,
      message: $managerId + ' started ' + $id + ' — "' + $goal + '"', at: $now
    })
    `,
    { id, goal, managerId, now },
  );
  return {
    ok: true as const,
    projectId: id,
    goal,
    managerId,
    yourRole: MANAGER_PLAYBOOK,
    workerBriefing: WORKER_BRIEFING,
    nextStep: `Call plan_project with project_id "${id}" and 2-6 subtask titles.`,
  };
}

export async function planProject(projectId: string, subtasks: string[], managerId = "manager") {
  if (subtasks.length === 0) {
    return { ok: false as const, projectId, reason: "no subtasks given" };
  }
  const now = iso();
  const rows = subtasks.map((title, i) => ({
    id: `${projectId}-S${i + 1}`,
    title,
    order: int(i + 1),
  }));
  const res = await driver.executeQuery(
    `
    MATCH (p:Project {id: $projectId})
    SET p.status = 'active', p.updatedAt = $now
    WITH p
    UNWIND $rows AS row
    CREATE (t:Task {
      id: row.id, title: row.title, status: 'awaiting', step: 'design',
      attempt: $one, maxAttempts: $maxAttempts,
      createdAt: $now, updatedAt: $now
    })
    CREATE (p)-[:HAS_SUBTASK {order: row.order}]->(t)
    WITH p, collect(t.id) AS ids
    MATCH (c:Counter {name: 'events'})
    SET c.seq = c.seq + 1
    CREATE (:Event {
      id: randomUUID(), seq: c.seq, type: 'project_planned', agentId: $managerId, taskId: p.id,
      message: $managerId + ' split ' + p.id + ' into ' + toString(size(ids)) + ' subtasks',
      at: $now
    })
    RETURN ids
    `,
    {
      projectId,
      rows,
      managerId,
      now,
      one: int(1),
      maxAttempts: int(DEFAULT_MAX_ATTEMPTS),
    },
  );
  if (res.records.length === 0) {
    return { ok: false as const, projectId, reason: "project not found" };
  }
  return {
    ok: true as const,
    projectId,
    subtaskIds: res.records[0].get("ids") as string[],
    workerBriefing: WORKER_BRIEFING,
    nextStep:
      "Spawn one subagent per subtask in parallel, each given the workerBriefing verbatim. " +
      "Spawn at least two so reviews can be assigned to someone who did not do the work.",
  };
}

/**
 * True when a task belongs to a project pipeline. The generic board tools use
 * this to refuse it: a subtask advances only through submit_step/submit_review,
 * so a plain claim or status write must not be able to skip the review steps.
 */
export async function isProjectSubtask(taskId: string): Promise<boolean> {
  const res = await driver.executeQuery(
    "MATCH (:Project)-[:HAS_SUBTASK]->(t:Task {id: $taskId}) RETURN t.id AS id LIMIT 1",
    { taskId },
  );
  return res.records.length > 0;
}

/**
 * Candidate subtasks this agent is allowed to pick up, best first.
 *
 * The reviewer guard lives here: an agent is never handed a review of work it
 * performed itself — AFTER_FAIL maps each review step back to the work step it
 * judges, so a past designer is barred from design_review but may still review
 * an execution. Because an agent's own PERFORMED edges only change when it
 * submits, reading this before claiming is safe — nothing else can add work
 * history on its behalf mid-flight.
 */
async function findCandidates(agentId: string, projectId?: string) {
  const res = await driver.executeQuery(
    `
    MATCH (p:Project {status: 'active'})-[h:HAS_SUBTASK]->(t:Task)
    WHERE ($projectId IS NULL OR p.id = $projectId)
      AND NOT t.status IN $terminal AND t.step <> 'done'
    OPTIONAL MATCH (:Agent)-[r:CLAIMED_BY]->(t)
    WITH t, h, r
    WHERE r IS NULL OR r.leaseExpiresAt IS NULL OR r.leaseExpiresAt <= $now
    OPTIONAL MATCH (:Agent {id: $agentId})-[perf:PERFORMED]->(t)
    WHERE t.step IN $reviewSteps AND perf.step = $afterFail[t.step]
    WITH t, h, count(perf) AS myAuthorship
    WHERE myAuthorship = 0
    RETURN t.id AS id, t.step AS step, h.order AS ord
    ORDER BY CASE WHEN t.step IN $reviewSteps THEN 0 ELSE 1 END, ord ASC
    LIMIT 10
    `,
    {
      agentId,
      projectId: projectId ?? null,
      now: iso(),
      terminal: [...TERMINAL_STATUSES],
      reviewSteps: [...REVIEW_STEPS],
      afterFail: AFTER_FAIL,
    },
  );
  return res.records.map((r) => ({ id: r.get("id") as string, step: r.get("step") as StepName }));
}

export async function getBriefing(subtaskId: string, agentId: string) {
  const res = await driver.executeQuery(
    `
    MATCH (p:Project)-[:HAS_SUBTASK]->(t:Task {id: $subtaskId})
    OPTIONAL MATCH (t)-[:CONTEXT]->(m:Memory)
    WITH p, t, m ORDER BY m.seq ASC
    WITH p, t, collect(m {.seq, .text, .authorId, .at}) AS memory
    OPTIONAL MATCH (w:Agent)-[perf:PERFORMED]->(t)
    WITH p, t, memory, w, perf ORDER BY perf.at ASC
    RETURN p.id AS projectId, p.goal AS goal, t.title AS title, t.step AS step,
           t.attempt AS attempt, t.maxAttempts AS maxAttempts,
           t.design AS design, t.output AS output, t.lastFeedback AS lastFeedback,
           memory,
           collect(CASE WHEN w IS NULL THEN NULL ELSE
             {agentId: w.id, step: perf.step, attempt: perf.attempt, at: perf.at} END) AS history
    `,
    { subtaskId },
  );
  const row = res.records[0];
  if (!row) return null;
  const step = row.get("step") as StepName;
  const rawHistory = (row.get("history") as (StepRecord | null)[]).filter((h) => h !== null);
  const memory = (row.get("memory") as MemoryNote[]).filter((m) => m.seq !== null);

  return {
    ok: true as const,
    agentId,
    subtaskId,
    projectId: row.get("projectId") as string,
    goal: row.get("goal") as string,
    title: row.get("title") as string,
    step,
    attempt: Number(row.get("attempt")),
    maxAttempts: Number(row.get("maxAttempts")),
    yourJob: STEP_BRIEF[step] ?? "Unknown step — call project_status and report to the manager.",
    // Only what this step actually needs to see.
    approvedDesign: step === "design" ? null : (row.get("design") as string | null),
    executionToReview: step === "execute_review" ? (row.get("output") as string | null) : null,
    lastReviewFeedback: row.get("lastFeedback") as string | null,
    memory: memory.map((m) => ({ ...m, seq: Number(m.seq) })),
    history: rawHistory.map((h) => ({ ...h, attempt: Number(h.attempt) })),
    submitWith: REVIEW_STEPS.includes(step as "design_review" | "execute_review")
      ? "submit_review"
      : "submit_step",
  };
}

/**
 * The one call a worker needs. Mints an identity on first contact, then finds
 * and atomically claims the best available step. Claims are arbitrated by the
 * CLAIMED_BY.token constraint, so racing workers can't be handed the same step —
 * the loser just tries the next candidate.
 */
export async function nextAssignment(agentId?: string, nickname?: string, projectId?: string) {
  const id = agentId ?? `worker-${shortId()}`;
  if (agentId) {
    if ((await agentRole(agentId)) === "manager") {
      return {
        ok: false as const,
        agentId,
        reason:
          "managers do not take assignments — spawn subagents to do the work and poll project_status",
      };
    }
  }
  await ensureAgent(id, nickname ?? id, "worker");

  const candidates = await findCandidates(id, projectId);
  for (const candidate of candidates) {
    const claim = await claimTask(candidate.id, id);
    if (claim.ok) {
      const briefing = await getBriefing(candidate.id, id);
      if (briefing) return briefing;
    }
  }
  return {
    ok: false as const,
    agentId: id,
    reason:
      candidates.length === 0
        ? "no work available right now"
        : "every available step was taken by another worker first",
    hint: "Reviews can only go to an agent who did not do the work. If subtasks are stuck waiting for review, more workers are needed.",
  };
}

export async function submitStep(subtaskId: string, agentId: string, output: string) {
  const now = iso();
  const session = driver.session();
  try {
    const records = await session.executeWrite(async (tx) => {
      const res = await tx.run(
        `
        MATCH (a:Agent {id: $agentId})-[r:CLAIMED_BY]->(t:Task {id: $subtaskId})
        WHERE t.step IN $workSteps
        WITH a, r, t, t.step AS fromStep, t.attempt AS attempt
        CREATE (a)-[:PERFORMED {step: fromStep, attempt: attempt, at: $now}]->(t)
        DELETE r
        SET t.design = CASE WHEN fromStep = 'design' THEN $output ELSE t.design END,
            t.output = CASE WHEN fromStep = 'execute' THEN $output ELSE t.output END,
            t.step = $afterWork[fromStep],
            t.status = 'awaiting',
            t.updatedAt = $now
        WITH t, a, fromStep
        MATCH (c:Counter {name: 'events'})
        SET c.seq = c.seq + 1
        CREATE (:Event {
          id: randomUUID(), seq: c.seq, type: 'step_submitted', agentId: a.id, taskId: t.id,
          message: a.id + ' submitted ' + fromStep + ' for ' + t.id + ' → awaiting ' + t.step,
          at: $now
        })
        RETURN t.step AS nextStep, fromStep AS submitted
        `,
        { subtaskId, agentId, output, now, workSteps: [...WORK_STEPS], afterWork: AFTER_WORK },
      );
      return (await res).records;
    });
    if (records.length === 0) {
      return {
        ok: false as const,
        subtaskId,
        reason:
          "you do not hold this subtask, or it is not on a design/execute step — call next_assignment",
      };
    }
    return {
      ok: true as const,
      subtaskId,
      submitted: records[0].get("submitted") as string,
      nowAwaiting: records[0].get("nextStep") as string,
      nextStep: "Call next_assignment again. Someone else must review this one.",
    };
  } finally {
    await session.close();
  }
}

export async function submitReview(
  subtaskId: string,
  agentId: string,
  verdict: Verdict,
  feedback: string,
) {
  if (verdict === "fail" && feedback.trim() === "") {
    return { ok: false as const, subtaskId, reason: "a failing review must include feedback" };
  }
  const now = iso();
  const session = driver.session();
  const cypher =
    verdict === "pass"
      ? `
        MATCH (a:Agent {id: $agentId})-[r:CLAIMED_BY]->(t:Task {id: $subtaskId})
        WHERE t.step IN $reviewSteps
        WITH a, r, t, t.step AS fromStep, t.attempt AS attempt
        CREATE (a)-[:PERFORMED {step: fromStep, attempt: attempt, at: $now}]->(t)
        DELETE r
        SET t.step = $afterPass[fromStep],
            t.status = CASE WHEN $afterPass[fromStep] = 'done' THEN 'done' ELSE 'awaiting' END,
            t.result = CASE WHEN $afterPass[fromStep] = 'done' THEN t.output ELSE t.result END,
            t.reviewNote = $feedback,
            t.updatedAt = $now
        WITH t, a, fromStep
        MATCH (c:Counter {name: 'events'})
        SET c.seq = c.seq + 1
        CREATE (:Event {
          id: randomUUID(), seq: c.seq, type: 'review_passed', agentId: a.id, taskId: t.id,
          message: a.id + ' passed ' + fromStep + ' on ' + t.id + ' → ' + t.step, at: $now
        })
        RETURN t.step AS nextStep, t.status AS status, fromStep AS reviewed, t.attempt AS attempt
        `
      : `
        MATCH (a:Agent {id: $agentId})-[r:CLAIMED_BY]->(t:Task {id: $subtaskId})
        WHERE t.step IN $reviewSteps
        WITH a, r, t, t.step AS fromStep, t.attempt + 1 AS nextAttempt
        CREATE (a)-[:PERFORMED {step: fromStep, attempt: t.attempt, at: $now}]->(t)
        DELETE r
        SET t.attempt = nextAttempt,
            t.step = $afterFail[fromStep],
            t.status = CASE WHEN nextAttempt > t.maxAttempts THEN 'blocked' ELSE 'awaiting' END,
            t.lastFeedback = $feedback,
            t.updatedAt = $now
        WITH t, a, fromStep
        MATCH (c:Counter {name: 'events'})
        SET c.seq = c.seq + 1
        CREATE (m:Memory {
          id: randomUUID(), seq: c.seq, kind: 'review_feedback', authorId: a.id,
          text: 'Failed ' + fromStep + ': ' + $feedback, at: $now
        })
        CREATE (t)-[:CONTEXT]->(m)
        SET c.seq = c.seq + 1
        CREATE (:Event {
          id: randomUUID(), seq: c.seq, type: 'review_failed', agentId: a.id, taskId: t.id,
          message: a.id + ' failed ' + fromStep + ' on ' + t.id + ' → back to ' + t.step +
                   ' (attempt ' + toString(t.attempt) + ')', at: $now
        })
        RETURN t.step AS nextStep, t.status AS status, fromStep AS reviewed, t.attempt AS attempt
        `;
  try {
    const records = await session.executeWrite(async (tx) => {
      const res = await tx.run(cypher, {
        subtaskId,
        agentId,
        feedback,
        now,
        reviewSteps: [...REVIEW_STEPS],
        afterPass: AFTER_PASS,
        afterFail: AFTER_FAIL,
      });
      return (await res).records;
    });
    if (records.length === 0) {
      return {
        ok: false as const,
        subtaskId,
        reason:
          "you do not hold this subtask, or it is not awaiting review — call next_assignment",
      };
    }
    const status = records[0].get("status") as string;
    const attempt = Number(records[0].get("attempt"));
    return {
      ok: true as const,
      subtaskId,
      verdict,
      reviewed: records[0].get("reviewed") as string,
      nowAt: records[0].get("nextStep") as string,
      status,
      attempt,
      nextStep:
        status === "blocked"
          ? "This subtask is out of attempts and now blocked — the manager must re-scope it."
          : "Call next_assignment again.",
    };
  } finally {
    await session.close();
  }
}

/**
 * Two scopes, one node type. A note on a subtask is inherited by whoever works
 * that subtask next — which matters because subagents are ephemeral and their
 * per-identity memory would die with them. A note on a project is the manager's
 * durable record of what was decomposed, tried, and finished.
 */
export async function remember(
  text: string,
  authorId: string,
  target: { subtaskId?: string; projectId?: string },
) {
  const scopeId = target.subtaskId ?? target.projectId;
  if (!scopeId) {
    return { ok: false as const, reason: "pass either subtask_id or project_id" };
  }
  const label = target.subtaskId ? "Task" : "Project";
  const res = await driver.executeQuery(
    `
    MATCH (scope:${label} {id: $scopeId})
    MATCH (c:Counter {name: 'events'})
    SET c.seq = c.seq + 1
    CREATE (m:Memory {
      id: randomUUID(), seq: c.seq, kind: $kind, text: $text,
      authorId: $authorId, at: $now
    })
    CREATE (scope)-[:CONTEXT]->(m)
    RETURN m.id AS id, m.seq AS seq
    `,
    {
      scopeId,
      text,
      authorId,
      kind: target.subtaskId ? "subtask_note" : "project_note",
      now: iso(),
    },
  );
  if (res.records.length === 0) {
    return { ok: false as const, reason: `${label.toLowerCase()} ${scopeId} not found` };
  }
  return {
    ok: true as const,
    memoryId: res.records[0].get("id") as string,
    seq: Number(res.records[0].get("seq")),
    scope: target.subtaskId ? "subtask" : "project",
    scopeId,
  };
}

export async function recall(target: {
  subtaskId?: string;
  projectId?: string;
  authorId?: string;
}): Promise<MemoryNote[]> {
  const scopeId = target.subtaskId ?? target.projectId;
  const label = target.subtaskId ? "Task" : "Project";
  const res = await driver.executeQuery(
    scopeId
      ? `
        MATCH (scope:${label} {id: $scopeId})-[:CONTEXT]->(m:Memory)
        WHERE $authorId IS NULL OR m.authorId = $authorId
        RETURN m.seq AS seq, m.text AS text, m.authorId AS authorId, m.at AS at
        ORDER BY m.seq ASC
        `
      : `
        MATCH (m:Memory)
        WHERE $authorId IS NULL OR m.authorId = $authorId
        RETURN m.seq AS seq, m.text AS text, m.authorId AS authorId, m.at AS at
        ORDER BY m.seq DESC LIMIT 50
        `,
    { scopeId, authorId: target.authorId ?? null },
  );
  return res.records.map((r) => ({
    seq: Number(r.get("seq")),
    text: r.get("text") as string,
    authorId: r.get("authorId") as string,
    at: r.get("at") as string,
  }));
}

/** The manager's view: the tree, where each subtask sits, and who did what. */
export async function projectStatus(projectId?: string) {
  const res = await driver.executeQuery(
    `
    MATCH (p:Project)
    WHERE $projectId IS NULL OR p.id = $projectId
    OPTIONAL MATCH (p)-[h:HAS_SUBTASK]->(t:Task)
    OPTIONAL MATCH (holder:Agent)-[:CLAIMED_BY]->(t)
    OPTIONAL MATCH (w:Agent)-[perf:PERFORMED]->(t)
    WITH p, h, t, holder, collect(DISTINCT w.id + ':' + perf.step) AS performed
    ORDER BY h.order ASC
    WITH p, collect(CASE WHEN t IS NULL THEN NULL ELSE {
      id: t.id, title: t.title, status: t.status, step: t.step,
      attempt: t.attempt, maxAttempts: t.maxAttempts,
      claimedBy: holder.id, lastFeedback: t.lastFeedback, performed: performed
    } END) AS subtasks
    RETURN p.id AS projectId, p.goal AS goal, p.status AS status,
           p.createdAt AS createdAt, subtasks
    ORDER BY p.createdAt DESC
    `,
    { projectId: projectId ?? null },
  );
  return res.records.map((r) => {
    const subtasks = (r.get("subtasks") as (SubtaskStatus | null)[])
      .filter((s): s is SubtaskStatus => s !== null)
      .map((s) => ({
        ...s,
        attempt: Number(s.attempt),
        maxAttempts: Number(s.maxAttempts),
      }));
    const blocked = subtasks.filter((s) => s.status === "blocked");
    return {
      projectId: r.get("projectId") as string,
      goal: r.get("goal") as string,
      status: r.get("status") as string,
      createdAt: r.get("createdAt") as string,
      subtasks,
      summary: {
        total: subtasks.length,
        done: subtasks.filter((s) => s.status === "done").length,
        blocked: blocked.length,
      },
      needsManager: blocked.map((s) => ({ id: s.id, lastFeedback: s.lastFeedback })),
    };
  });
}
