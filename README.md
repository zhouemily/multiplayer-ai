# Multiplayer AI — Agent Team Orchestrator

Attach this MCP server to your AI client and one chat becomes a team. You talk to
a single **manager** agent; it decomposes your goal and dispatches **subagents**,
and every subtask is forced through `design → design_review → execute →
execute_review` by a **different** agent at each step. A failed review doesn't
fail the subtask — it sends the work back with feedback and burns an attempt.

Neo4j Aura is the shared workspace all of them coordinate through: **a claim is
an edge in the graph**, and the whole locking mechanism is one database
constraint. A monitor UI shows the pipeline live.

```
                  you, in your normal AI client
                              |
                              v
                    +-------------------+
                    |  manager agent    |  start_project → plan_project
                    |  never does work  |  → project_status
                    +---------+---------+
                              | spawns subagents (they inherit your MCP config)
        +---------------+-----+---------+---------------+
        v               v               v               v
    +--------+      +--------+      +--------+      +--------+
    | design |      | design |      |execute |      |execute |   next_assignment
    |        |      | review |      |        |      | review |   → submit_step
    +---+----+      +---+----+      +---+----+      +---+----+   → submit_review
        |               |               |               |
        +---------------+-------+-------+---------------+
                                v
                     +---------------------+
                     |     MCP server      |  14 tools, Streamable HTTP :3333
                     +----------+----------+
                                v
                     +---------------------+
                     |     Neo4j Aura      |  (:Project)-[:HAS_SUBTASK]->(:Task)
                     |  CLAIMED_BY edge    |  UNIQUE constraint on r.token
                     +----------+----------+
                                | read-only
                                v
                     +---------------------+
                     |     Monitor UI      |  live pipeline + feed + override
                     +---------------------+
```

## Setup

One MCP server entry is the whole install. You need a Neo4j Aura instance (the
free tier is enough) and its connection credentials.

```
cp .env.example .env    # fill in NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD
npm install
npm run mcp             # MCP server on http://localhost:3333/mcp
```

Then point your client at it. For Claude Code:

```
claude mcp add --transport http task-board http://localhost:3333/mcp
```

For clients that use a JSON config file:

```json
{
  "mcpServers": {
    "task-board": { "type": "http", "url": "http://localhost:3333/mcp" }
  }
}
```

Nothing else to configure. Say *"start a project to <your goal>"* and the agent
takes it from there — `start_project` returns the manager playbook, so the model
learns the protocol from the server rather than from your prompt.

Optionally, in a second terminal:

```
npm run web             # monitor UI on http://localhost:3334
```

## The 14 tools

**Manager** — `start_project` (returns the playbook and the briefing to paste
into each subagent), `plan_project` (2–6 independent subtask titles),
`project_status` (every step, attempt count and holder; `needsManager` lists
subtasks that ran out of attempts).

**Subagent** — `next_assignment` is the only call a worker needs: it returns one
step to do plus the goal, the approved design, any failed-review feedback, and
the subtask's memory. Omit `agent_id` and the server mints an identity. Then
`submit_step` (design/execute) or `submit_review` (pass/fail + feedback).

**Memory, two tiers** — `remember` / `recall`, scoped to a `subtask_id` (context
for whoever picks that subtask up next) or a `project_id` (manager-level notes on
what was decomposed, tried and finished).

**Standalone board** — `list_tasks`, `add_task`, `claim_task`, `update_task`,
`release_task`, `list_events`, for work that doesn't need a pipeline.

## The four guards

Everything the protocol promises is enforced server-side, not by prompting:

1. **The manager cannot do the work.** `next_assignment` refuses an agent with
   role `manager`. It can only decompose and monitor.
2. **Nobody reviews their own work.** Each agent's steps are recorded as
   `PERFORMED` edges; a design's author is never handed that design's review. It
   *may* still review a later execution of the same subtask — the guard maps each
   review step back to the one work step it judges, so it doesn't lock out the
   only available reviewer.
3. **A subtask can't be driven straight to done.** `claim_task` and `update_task`
   refuse project subtasks, so the generic board tools can't skip the reviews.
   Subtasks also rest at status `awaiting` rather than `todo`, so a plain board
   agent doesn't even see them as free work.
4. **A failing reviewer can't loop forever.** Each fail burns an attempt; past
   `MAX_ATTEMPTS` (default 3) the subtask goes `blocked` and surfaces in
   `project_status.needsManager` for a human-in-the-loop decision.

```
npm run pipeline-test   # 25 checks: the pipeline, the iteration, all four guards
```

## Why claims can't double-book

`claim_task` is one Cypher statement: create a `CLAIMED_BY` edge whose `token`
property is the task id. A **relationship property uniqueness constraint** on
`CLAIMED_BY.token` means the database itself rejects a second active claim on
the same task — if two agents race, the loser's transaction (including its feed
event) rolls back atomically. No lock tables, no CRDTs, no application-level
locking. Verify it:

```
npm run seed        # ⚠️ wipes tasks, projects and events
npm run race-test   # 10 rounds × 8 concurrent claims → exactly 1 winner each
```

## Why a dead agent can't wedge the board

Each claim carries a lease — `leaseExpiresAt` on the same edge. Claiming deletes
expired claim edges inside its own statement, so an abandoned subtask becomes
assignable again and the takeover is still arbitrated by the uniqueness
constraint (two agents racing for one expired lease still produce exactly one
winner, logged as `claim_stolen`). This is what makes ephemeral subagents safe:
one that dies mid-step costs a lease window, not the project. Set
`LEASE_MINUTES` in `.env` to change the window.

```
npm run lease-test  # claim → crash → peer takes over, still race-safe
```

## Monitor UI

`npm run web` serves a read-only view on :3334 that polls the graph every
second: each project with its subtasks, which of the four steps each subtask is
on, attempt counts, who holds what, and a live activity feed. Standalone tasks
get the kanban below. The "force release" button and the "Add a task" box are
human overrides that go through the **same MCP tools the agents use**, logged as
agent `human`.

## Repo layout

- `server/` — MCP server (Streamable HTTP), Cypher, seed, and the race / lease /
  pipeline tests
- `web/` — read API + single-page monitor UI (polls 1s, draws live claim edges)
- `agents/` — a scripted coworker simulator, not part of the product. It runs the
  plain board loop (claim → work → done) so you can watch contention and lease
  takeover without a second AI client attached: `npm run agent:a`, `npm run
  agent:b`. It can't disturb a project — it only picks up `todo` tasks, and
  subtasks rest at `awaiting`.

## Graph schema

```
(:Project {id, goal, status, createdAt})
(:Task {id, title, status, step, attempt, maxAttempts, design, output, lastFeedback, result, ...})
(:Agent {id, name, role})          // role: 'manager' | 'worker'
(:Memory {id, seq, kind, text, authorId, at})
(:Event {id, seq, type, agentId, taskId, message, at})   // activity feed
(:Counter {name: 'events', seq})

(:Project)-[:HAS_SUBTASK {order}]->(:Task)
(:Agent)-[:CLAIMED_BY {token: <task id>, claimedAt, leaseExpiresAt}]->(:Task)
(:Agent)-[:PERFORMED {step, attempt, at}]->(:Task)       // review guard + audit
(:Project|:Task)-[:CONTEXT]->(:Memory)                   // two memory tiers
```

Steps run `design → design_review → execute → execute_review → done`. Statuses:
`todo` (standalone only) · `awaiting` (subtask resting between steps) ·
`in_progress` (claimed) · `done` · `blocked` (out of attempts).

## Troubleshooting

- **`EADDRINUSE` on :3333 / :3334** — a previous server instance is still
  running; kill it first.
- **First Aura connection can be slow** — Aura Free occasionally queues new
  connections for a while (we saw a seed take ~6 min once, then 6 s after).
  Drivers use a 20 s connection timeout and small pools to surface this quickly;
  just retry.
- **Start `mcp` before `web`** — the UI opens an MCP client at startup so its
  write buttons go through the same contract as the agents.
- **A subtask sits in `awaiting` forever** — no subagent is pulling. The manager
  has to spawn one; the server can't reach out to your client.
- **`npm run seed` is destructive** — it deletes every task, project and event.
  Don't run it against a database someone else is demoing on.
