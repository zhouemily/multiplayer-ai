# Multiplayer AI — Shared Task Board

Two AI agents work the same shared task board at the same time, without
overwriting each other. Neo4j Aura is the single source of truth: **a claim is
an edge in the graph**, and the whole locking mechanism is one database
constraint. A monitoring UI shows both agents live.

```
+--------------+     +--------------+
|   Agent A    |     |   Agent B    |     simple agent loops
+------+-------+     +------+-------+
       |  MCP tools          |  MCP tools
       +---------+-----------+
                 v
        +------------------+
        |  MCP server      |  list_tasks · claim_task · release_task · update_task
        +--------+---------+
                 v
        +------------------+
        |  Neo4j Aura      |  (:Task), (:Agent), (:Event)
        |  CLAIMED_BY edge |  UNIQUE constraint on r.token = task id
        +--------+---------+
                 | read-only
                 v
        +------------------+
        |  Monitor UI      |  live board + activity feed + human override
        +------------------+
```

## Why claims can't double-book

`claim_task` is one Cypher statement: create a `CLAIMED_BY` edge whose `token`
property is the task id. A **relationship property uniqueness constraint** on
`CLAIMED_BY.token` means the database itself rejects a second active claim on
the same task — if two agents race, the loser's transaction (including its feed
event) rolls back atomically. No lock tables, no CRDTs, no application-level
locking. Verify it:

```
npm run mcp        # in one terminal (needs .env)
npm run seed
npm run race-test  # 10 rounds × 8 concurrent claims → exactly 1 winner each
```

## Why a dead agent can't wedge the board

Each claim carries a lease — `leaseExpiresAt` on the same edge. `claim_task`
deletes expired claim edges inside its own statement, so an abandoned task
becomes claimable again and the takeover is still arbitrated by the uniqueness
constraint (two agents racing for one expired lease still produce exactly one
winner, logged as `claim_stolen`). Set `LEASE_MINUTES` in `.env` to change the
window; the default of 10 comfortably outlasts the 3–9s of simulated work.
`claim_task` also refuses tasks that are already `done`.

```
npm run lease-test  # claim → crash → peer takes over, still race-safe
```

## Setup

```
cp .env.example .env    # fill in NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD
npm install
```

## Run the demo

Four terminals (or one per teammate):

```
npm run seed     # reset board: 6 tasks, agents A + B
npm run mcp      # MCP server on :3333
npm run web      # monitor UI on :3334 → open http://localhost:3334
npm run agent:a  # agent A loop
npm run agent:b  # agent B loop
```

Watch both agents claim, work, and complete tasks. The activity feed shows
`claim_lost` events whenever they race for the same task and the database
arbitrates. The UI's "force release" button and the "Add a task" box are human
overrides — they go through the **same MCP tools the agents use**, logged as
agent `human`.

## Repo layout

- `server/` — MCP server (Streamable HTTP) + Cypher + seed + race/lease tests
- `agents/` — agent loop; `a` or `b` as argv picks the identity
- `web/` — read API + single-page monitor UI (polls 1s, draws live claim edges)

## Graph schema

```
(:Task {id, title, status, result, createdAt, updatedAt})
(:Agent {id, name})
(:Event {id, seq, type, agentId, taskId, message, at})   // activity feed
(:Counter {name: 'events', seq})

(:Agent)-[:CLAIMED_BY {token: <task id>, claimedAt, leaseExpiresAt}]->(:Task)
```

Task statuses: `todo` → `in_progress` (on claim) → `done`. `done` is terminal —
`claim_task` refuses it.

## Troubleshooting

- **Start order matters**: `mcp` before `web` (the UI connects to the MCP
  server at startup) and before the agents.
- **`EADDRINUSE` on :3333 / :3334** — a previous server instance is still
  running; kill it first.
- **First Aura connection can be slow** — Aura Free occasionally queues new
  connections for a while (we saw a seed take ~6 min once, then 6 s after).
  Drivers are configured with a 20 s connection timeout and small connection
  pools to surface this quickly; just retry.
- **Agents log `board unreachable, retrying`** — the MCP server is down or
  restarting. Agents retry on their own and resume when it's back; no need to
  restart them.
- **Reseeding mid-run is safe** — the seed wipes tasks/events; agents go idle
  and pick up the fresh board automatically.
