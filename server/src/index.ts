import fs from "node:fs/promises";
import { startAlertScheduler } from "./alerts.js";
import { startRetentionScheduler } from "./retention.js";
import { startReportScheduler } from "./reports.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { createFirstAdmin } from "./routes/admin.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);

async function connectWithRetry(attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`waiting for database (${i}/${attempts}): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

await connectWithRetry();
const applied = await migrate(db, config.migrationsDir);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
await fs.mkdir(config.dataDir, { recursive: true });

// Optional unattended bootstrap of the first admin from env (never overwrites an existing admin).
const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, ORG_NAME } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  if (ADMIN_PASSWORD.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters; skipping bootstrap admin");
  } else {
    const created = await createFirstAdmin(db, {
      name: ADMIN_NAME || "Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      orgName: ORG_NAME,
    });
    if (created) console.log(`bootstrap admin created: ${created.email}`);
  }
}

const app = await buildApp(db, config, { logger: true });
await app.listen({ port: config.port, host: config.host });

const stopAlerts = startAlertScheduler(db, config);
const stopRetention = startRetentionScheduler(db, config);
const stopReports = startReportScheduler(db, config);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopAlerts();
    stopRetention();
    stopReports();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
