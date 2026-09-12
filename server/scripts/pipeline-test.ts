import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { driver } from "../src/db.js";
import { optional } from "../src/env.js";

const MCP_URL = optional("MCP_URL", `http://localhost:${optional("MCP_PORT", "3333")}/mcp`);

interface Assignment {
  ok: boolean;
  agentId: string;
  subtaskId?: string;
  step?: string;
  attempt?: number;
  title?: string;
  goal?: string;
  approvedDesign?: string | null;
  executionToReview?: string | null;
  lastReviewFeedback?: string | null;
  memory?: { text: string; authorId: string }[];
  submitWith?: string;
  reason?: string;
}

interface StepResult {
  ok: boolean;
  submitted?: string;
  nowAwaiting?: string;
  reason?: string;
}

interface ReviewResult {
  ok: boolean;
  verdict?: string;
  reviewed?: string;
  nowAt?: string;
  status?: string;
  attempt?: number;
  reason?: string;
}

interface ProjectStatus {
  projectId: string;
  status: string;
  subtasks: {
    id: string;
    step: string;
    status: string;
    attempt: number;
    performed: string[];
  }[];
  summary: { total: number; done: number; blocked: number };
  needsManager: { id: string }[];
}

let failures = 0;

function check(label: string, pass: boolean, detail = ""): void {
  if (pass) {
    console.log(`ok   — ${label}`);
  } else {
    failures++;
    console.error(`FAIL — ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function main() {
  const client = new Client({ name: "pipeline-test", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === "text",
    )?.text;
    if (!text) throw new Error(`Tool ${name} returned no text`);
    return JSON.parse(text) as T;
  };

  // ---- manager decomposes -------------------------------------------------
  const started = await call<{
    ok: boolean;
    projectId: string;
    yourRole: string;
    workerBriefing: string;
  }>("start_project", { goal: "Ship a pipeline smoke test", agent_id: "mgr-test" });
  check("start_project returns a project id", started.ok && !!started.projectId, started.projectId);
  check(
    "start_project hands back the manager playbook and worker briefing",
    started.yourRole.includes("MANAGER") && started.workerBriefing.includes("next_assignment"),
  );

  const planned = await call<{ ok: boolean; subtaskIds: string[] }>("plan_project", {
    project_id: started.projectId,
    subtasks: ["Subtask alpha", "Subtask beta"],
    agent_id: "mgr-test",
  });
  check("plan_project creates both subtasks", planned.ok && planned.subtaskIds.length === 2);

  // ---- the manager must not be able to take work -------------------------
  const managerPull = await call<Assignment>("next_assignment", {
    agent_id: "mgr-test",
    project_id: started.projectId,
  });
  check(
    "manager is refused an assignment",
    !managerPull.ok && (managerPull.reason ?? "").includes("managers do not take assignments"),
    managerPull.reason,
  );

  // ---- worker one designs ------------------------------------------------
  const first = await call<Assignment>("next_assignment", {
    nickname: "worker-one",
    project_id: started.projectId,
  });
  check(
    "a fresh worker is minted an identity and handed a design step",
    first.ok && first.step === "design" && !!first.agentId,
    `${first.agentId} → ${first.step}`,
  );
  check("the design step carries the project goal", first.goal === "Ship a pipeline smoke test");
  check("a designer is not shown a design to review", first.approvedDesign === null);
  const workerA = first.agentId;
  const subtask = first.subtaskId!;

  await call("remember", {
    text: "Alpha depends on the shared fixture in scripts/.",
    agent_id: workerA,
    subtask_id: subtask,
  });

  const designed = await call<StepResult>("submit_step", {
    subtask_id: subtask,
    agent_id: workerA,
    output: "Plan: add a smoke script, assert on exit code.",
  });
  check(
    "submitting design sends it to design_review",
    designed.ok && designed.nowAwaiting === "design_review",
    designed.nowAwaiting ?? designed.reason,
  );

  // ---- the designer may not review their own design ----------------------
  const selfReview = await call<Assignment>("next_assignment", {
    agent_id: workerA,
    project_id: started.projectId,
  });
  check(
    "the designer is never handed its own design_review",
    !selfReview.ok || selfReview.subtaskId !== subtask || selfReview.step !== "design_review",
    `${selfReview.step ?? selfReview.reason} on ${selfReview.subtaskId ?? "-"}`,
  );
  // It was handed the sibling subtask instead; hand it back so its lease does
  // not stand in the way of the attempt-exhaustion loop below.
  if (selfReview.ok) {
    await call("release_task", { task_id: selfReview.subtaskId, agent_id: workerA });
  }

  // ---- worker two reviews, and fails it ----------------------------------
  let second = await call<Assignment>("next_assignment", {
    nickname: "worker-two",
    project_id: started.projectId,
  });
  const workerB = second.agentId;
  // worker-two may get handed the other subtask's design first; keep pulling
  // until it lands on the review that worker-one just queued.
  for (let i = 0; i < 4 && second.ok && second.subtaskId !== subtask; i++) {
    await call("release_task", { task_id: second.subtaskId, agent_id: workerB });
    second = await call<Assignment>("next_assignment", {
      agent_id: workerB,
      project_id: started.projectId,
    });
  }
  check(
    "a different worker picks up the design_review",
    second.ok && second.subtaskId === subtask && second.step === "design_review",
    `${second.agentId} → ${second.step} on ${second.subtaskId}`,
  );
  check(
    "the reviewer sees the design it must judge",
    (second.approvedDesign ?? "").includes("smoke script"),
  );
  check(
    "the reviewer inherits the designer's subtask memory",
    (second.memory ?? []).some((m) => m.text.includes("shared fixture")),
  );

  const failedReview = await call<ReviewResult>("submit_review", {
    subtask_id: subtask,
    agent_id: workerB,
    verdict: "fail",
    feedback: "No assertion on the failure path — say what a bad exit looks like.",
  });
  check(
    "a failed design_review sends the subtask back to design",
    failedReview.ok && failedReview.nowAt === "design" && failedReview.attempt === 2,
    `${failedReview.nowAt} attempt ${failedReview.attempt}`,
  );

  // ---- the feedback reaches the next designer ----------------------------
  const redesign = await call<Assignment>("next_assignment", { agent_id: workerA });
  check(
    "the next design attempt carries the reviewer's feedback",
    redesign.ok &&
      redesign.subtaskId === subtask &&
      (redesign.lastReviewFeedback ?? "").includes("failure path"),
    redesign.lastReviewFeedback ?? redesign.reason,
  );
  check(
    "the failed review is also written into subtask memory",
    (redesign.memory ?? []).some((m) => m.text.includes("Failed design_review")),
  );

  await call("submit_step", {
    subtask_id: subtask,
    agent_id: workerA,
    output: "Plan v2: assert exit code 0 and a non-zero path.",
  });

  // ---- pass design, then execute, then pass execution -------------------
  // A review is submitted by whoever holds the subtask, so the reviewer pulls
  // the queued review as an assignment first — same as it did on attempt 1.
  const reReview = await call<Assignment>("next_assignment", {
    agent_id: workerB,
    project_id: started.projectId,
  });
  check(
    "the original reviewer may judge the revised design",
    reReview.ok && reReview.subtaskId === subtask && reReview.step === "design_review",
    `${reReview.step ?? reReview.reason} on ${reReview.subtaskId ?? "-"}`,
  );

  const pass1 = await call<ReviewResult>("submit_review", {
    subtask_id: subtask,
    agent_id: workerB,
    verdict: "pass",
    feedback: "Covers both paths now.",
  });
  check(
    "a passed design_review advances to execute",
    pass1.ok && pass1.nowAt === "execute",
    pass1.nowAt ?? pass1.reason,
  );

  const exec = await call<Assignment>("next_assignment", {
    agent_id: workerB,
    project_id: started.projectId,
  });
  check(
    "the executor is shown the approved design",
    exec.ok && exec.step === "execute" && (exec.approvedDesign ?? "").includes("Plan v2"),
    `${exec.step} / ${exec.approvedDesign?.slice(0, 20)}`,
  );

  await call("submit_step", {
    subtask_id: subtask,
    agent_id: workerB,
    output: "Wrote scripts/pipeline-test.ts; both paths asserted.",
  });

  const finalReview = await call<Assignment>("next_assignment", {
    agent_id: workerA,
    project_id: started.projectId,
  });
  check(
    "execute_review goes to someone who did not execute",
    finalReview.ok &&
      finalReview.step === "execute_review" &&
      (finalReview.executionToReview ?? "").includes("both paths asserted"),
    `${finalReview.agentId} → ${finalReview.step}`,
  );

  const done = await call<ReviewResult>("submit_review", {
    subtask_id: subtask,
    agent_id: workerA,
    verdict: "pass",
    feedback: "Verified.",
  });
  check(
    "a passed execute_review finishes the subtask",
    done.ok && done.nowAt === "done" && done.status === "done",
    `${done.nowAt} / ${done.status}`,
  );

  // ---- a failing review cannot loop forever -----------------------------
  const status = await call<ProjectStatus[]>("project_status", { project_id: started.projectId });
  const beta = status[0].subtasks.find((s) => s.id !== subtask)!;
  let guard = 0;
  let betaStatus = beta.status;
  while (betaStatus !== "blocked" && guard++ < 14) {
    const a = await call<Assignment>("next_assignment", {
      nickname: `burner-${guard}`,
      project_id: started.projectId,
    });
    if (!a.ok || a.subtaskId !== beta.id) {
      if (a.ok) await call("release_task", { task_id: a.subtaskId, agent_id: a.agentId });
      continue;
    }
    if (a.submitWith === "submit_step") {
      await call("submit_step", { subtask_id: beta.id, agent_id: a.agentId, output: "attempt" });
    } else {
      const r = await call<ReviewResult>("submit_review", {
        subtask_id: beta.id,
        agent_id: a.agentId,
        verdict: "fail",
        feedback: "not good enough",
      });
      betaStatus = r.status ?? betaStatus;
    }
  }
  check(
    "a subtask that exhausts its attempts becomes blocked",
    betaStatus === "blocked",
    `ended as ${betaStatus}`,
  );

  const blockedPull = await call<Assignment>("next_assignment", {
    nickname: "late-worker",
    project_id: started.projectId,
  });
  check(
    "a blocked subtask is no longer handed out",
    !blockedPull.ok || blockedPull.subtaskId !== beta.id,
    blockedPull.subtaskId ?? blockedPull.reason,
  );

  const finalStatus = await call<ProjectStatus[]>("project_status", {
    project_id: started.projectId,
  });
  check(
    "project_status escalates the blocked subtask to the manager",
    finalStatus[0].needsManager.some((n) => n.id === beta.id),
    JSON.stringify(finalStatus[0].summary),
  );
  check(
    "the graph records who performed which step",
    finalStatus[0].subtasks
      .find((s) => s.id === subtask)!
      .performed.some((p) => p.includes(":design")),
  );

  // ---- feedback must be substantive -------------------------------------
  const emptyFail = await call<ReviewResult>("submit_review", {
    subtask_id: subtask,
    agent_id: workerA,
    verdict: "fail",
    feedback: "   ",
  });
  check(
    "a failing review without feedback is rejected",
    !emptyFail.ok && (emptyFail.reason ?? "").includes("must include feedback"),
    emptyFail.reason,
  );

  await client.close();
  await driver.close();

  console.log(
    failures === 0
      ? "\nPASS — design/execute/review pipeline holds, including both guards."
      : `\nFAIL — ${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
