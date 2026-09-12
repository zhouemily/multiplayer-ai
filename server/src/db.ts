import neo4j from "neo4j-driver";
import { required } from "./env.js";

export const NEO4J_URI = required("NEO4J_URI");
export const NEO4J_USER = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "neo4j";
export const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? required("NEO4J_PASSWORD");

// Must outlast any legitimate task, but stay short enough that a crashed agent's
// board gets picked up again within the demo. Agents simulate 3-9s of work.
export const LEASE_MINUTES = Number(process.env.LEASE_MINUTES ?? "10");

// A failing reviewer must not be able to loop a subtask forever.
export const DEFAULT_MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? "3");

export const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
  // Aura Free has a low concurrent-connection cap; small pools keep the
  // instance from queuing new connections for minutes.
  { connectionTimeout: 20_000, maxConnectionPoolSize: 6 },
);

export async function initSchema(): Promise<void> {
  await driver.executeQuery(
    "CREATE CONSTRAINT task_id IF NOT EXISTS FOR (t:Task) REQUIRE t.id IS UNIQUE",
  );
  await driver.executeQuery(
    "CREATE CONSTRAINT agent_id IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE",
  );
  await driver.executeQuery(
    "CREATE CONSTRAINT event_id IF NOT EXISTS FOR (e:Event) REQUIRE e.id IS UNIQUE",
  );
  await driver.executeQuery(
    "CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE",
  );
  await driver.executeQuery(
    "CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
  );
  // The entire locking mechanism: at most one active CLAIMED_BY edge per task.
  await driver.executeQuery(
    "CREATE CONSTRAINT claim_token IF NOT EXISTS FOR ()-[r:CLAIMED_BY]-() REQUIRE r.token IS UNIQUE",
  );
  await driver.executeQuery(
    "MERGE (c:Counter {name: 'events'}) ON CREATE SET c.seq = 0",
  );
}

export async function checkConnection(): Promise<void> {
  await driver.verifyConnectivity();
}
