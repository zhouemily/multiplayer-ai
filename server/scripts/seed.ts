import { checkConnection, driver, initSchema } from "../src/db.js";
import { logEvent } from "../src/queries.js";

const TASKS = [
  "Draft the project README",
  "Design the landing page hero",
  "Set up the CI pipeline",
  "Write API documentation",
  "Build the demo slide deck",
  "Audit dependencies for CVEs",
];

async function main() {
  await checkConnection();
  await initSchema();

  // Reset the workspace: projects, tasks, memory, events and any claims. Agents
  // are kept — their ids appear in the event history.
  await driver.executeQuery("MATCH (n:Project) DETACH DELETE n");
  await driver.executeQuery("MATCH (n:Task) DETACH DELETE n");
  await driver.executeQuery("MATCH (n:Memory) DETACH DELETE n");
  await driver.executeQuery("MATCH (n:Event) DELETE n");
  await driver.executeQuery("MATCH (c:Counter {name: 'events'}) SET c.seq = 0");

  await driver.executeQuery(
    `MERGE (a:Agent {id: 'agent-a'}) ON CREATE SET a.name = 'Agent A'`,
  );
  await driver.executeQuery(
    `MERGE (a:Agent {id: 'agent-b'}) ON CREATE SET a.name = 'Agent B'`,
  );

  const now = new Date().toISOString();
  for (let i = 0; i < TASKS.length; i++) {
    await driver.executeQuery(
      `
      MERGE (t:Task {id: $id})
      ON CREATE SET t.title = $title, t.status = 'todo',
                    t.createdAt = $now, t.updatedAt = $now
      `,
      { id: `T${i + 1}`, title: TASKS[i], now },
    );
  }

  await logEvent("board_seeded", "human", "", `Board reset — ${TASKS.length} tasks ready`);

  const summary = await driver.executeQuery(
    "MATCH (t:Task) RETURN count(t) AS tasks",
  );
  console.log(
    `Seeded ${summary.records[0].get("tasks")} tasks and 2 agents (agent-a, agent-b).`,
  );
  await driver.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
