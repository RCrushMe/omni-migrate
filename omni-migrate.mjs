#!/usr/bin/env node
/**
 * omni-migrate — Export & import OmniRoute database across installs
 *
 * Works for both npm CLI (`omniroute serve`) and Electron desktop app.
 * Uses system Node.js + node:sqlite to read any SQLite database,
 * regardless of which driver (better-sqlite3 / sql.js) the app uses.
 *
 * Usage (all commands require --experimental-sqlite):
 *   node --experimental-sqlite omni-migrate.mjs <command> [options]
 *
 * Commands:
 *   export      Read old DB → write JSON + SQL files
 *   delete      Remove old DB (+ WAL/SHM)
 *   sql-import  Write SQL directly into DB (server must be stopped)
 *   import      POST JSON via REST API (server must be running)
 *   migrate     All-in-one: export → delete → start → sql-import → restart
 *   detect      Show detected DB paths for npm CLI and Electron
 *
 * See README.md for full documentation.
 */

import { DatabaseSync } from "node:sqlite";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { platform, arch } from "node:os";

// ─── Cross-platform path detection ───────────────────────────────────────────

const IS_WIN = platform() === "win32";
const IS_LINUX = platform() === "linux";

/**
 * Detect OmniRoute data directories.
 *
 * npm CLI:  ~/.omniroute/              (all platforms)
 * Electron:
 *   Win:    %APPDATA%/omniroute/       (C:\Users\<user>\AppData\Roaming\omniroute)
 *   Linux:  ~/.config/omniroute/       (XDG_CONFIG_HOME or ~/.config)
 */
function detectDataDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";

  const npmDir = join(home, ".omniroute");

  let electronDir;
  if (IS_WIN) {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    electronDir = join(appData, "omniroute");
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
    electronDir = join(xdgConfig, "omniroute");
  }

  return { npmDir, electronDir };
}

function findDbFile(dataDir) {
  const dbPath = join(dataDir, "storage.sqlite");
  return existsSync(dbPath) ? dbPath : null;
}

function detectTarget(targetFlag) {
  if (targetFlag === "npm" || targetFlag === "electron") return targetFlag;

  // Auto-detect: prefer the one that has a database file
  const { npmDir, electronDir } = detectDataDirs();
  const npmDb = findDbFile(npmDir);
  const electronDb = findDbFile(electronDir);

  if (npmDb && electronDb) {
    console.log("⚠️  Found databases in both npm CLI and Electron locations.");
    console.log(`   npm:      ${npmDb}`);
    console.log(`   Electron: ${electronDb}`);
    console.log("   Using npm CLI database. Use --target electron to override.\n");
    return "npm";
  }
  if (electronDb) return "electron";
  return "npm"; // default
}

function getDataDir(target) {
  const { npmDir, electronDir } = detectDataDirs();
  return target === "electron" ? electronDir : npmDir;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 20128;

/**
 * Tables that are pure runtime/analytics/ephemeral — NOT exported.
 * These will be recreated by the app on next start.
 */
const SKIP_TABLES = new Set([
  "_omniroute_migrations",
  "db_meta", // schema version — must stay as-is in target
  "sqlite_sequence",
  // Runtime logs (large, ephemeral — safe to skip)
  "call_logs",
  "request_detail_logs",
  "proxy_logs",
  "relay_logs",
  "middleware_logs",
  "plugin_analytics",
  "plugin_metrics",
  "mcp_tool_audit",
  "compression_analytics",
  "compression_cache_stats",
  "routing_decisions",
  "usage_history",
  "daily_usage_summary",
  "hourly_usage_summary",
  "domain_cost_history",
  "xp_audit_log",
  // Batch processing
  "batches",
  "batch_item_checkpoints",
  // Inspector
  "inspector_sessions",
  "inspector_session_requests",
  "inspector_custom_hosts",
  // Ephemeral state (rebuilt by app)
  "webhook_deliveries",
  "semantic_cache",
  "session_account_affinity",
  "session_model_history",
  "free_proxy_sync_errors",
  "relay_rate_limits",
  "a2a_tasks",
  "a2a_task_events",
  "context_handoffs",
  "token_ledger",
  // FTS internal (rebuilt from source data)
  "memory_fts",
  "memory_fts_config",
  "memory_fts_data",
  "memory_fts_docsize",
  "memory_fts_idx",
  // Quota runtime (counters reset on restart)
  "quota_consumption",
  "quota_snapshots",
  "quota_pool_connections",
  // Domain runtime (state resets)
  "domain_lockout_state",
  "domain_fallback_chains",
  // Counter tables (rebuilt by app)
  "account_key_limits",
  "provider_key_limits",
  "api_key_token_counters",
  "api_key_token_limit_reset_logs",
  "api_key_token_limits",
  // Learning (rebuilt by app)
  "combo_adaptation_state",
  "discovery_results",
  "skill_executions",
  // Version tracking (app creates its own entries)
  "version_manager",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = {};
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--db" && args[i + 1]) opts.db = args[++i];
    else if (a === "--out" && args[i + 1]) opts.out = args[++i];
    else if (a === "--host" && args[i + 1]) opts.host = args[++i];
    else if (a === "--port" && args[i + 1]) opts.port = parseInt(args[++i], 10);
    else if (a === "--file" && args[i + 1]) opts.file = args[++i];
    else if (a === "--target" && args[i + 1]) opts.target = args[++i];
    else if (a === "--force" || a === "--yes" || a === "-y") opts.force = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function confirm(msg, force = false) {
  if (force) return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${msg} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

function sqlEscape(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  if (typeof val === "bigint") return String(val);
  if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
    const buf = Buffer.from(val);
    return `X'${buf.toString("hex")}'`;
  }
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function snakeToCamel(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function rowToLegacy(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}

// ─── Omniroute CLI wrapper (cross-platform) ──────────────────────────────────

async function omnirouteCmd(args) {
  const { execSync, spawn } = await import("node:child_process");

  // Try global omniroute first, then npx
  for (const cmd of ["omniroute", "npx omniroute"]) {
    try {
      const fullCmd = `${cmd} ${args}`;
      const result = execSync(fullCmd, {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
        shell: IS_WIN ? "cmd.exe" : "/bin/sh",
      });
      return { ok: true, stdout: result };
    } catch {
      continue;
    }
  }
  return { ok: false };
}

// ─── Export ──────────────────────────────────────────────────────────────────

function exportDatabase(dbPath, outDir) {
  if (!existsSync(dbPath)) {
    console.error(`❌ Database not found: ${dbPath}`);
    process.exit(1);
  }

  console.log(`📖 Opening database: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

  console.log(`   Found ${tables.length} tables`);

  // ── Part 1: Legacy JSON backup ──
  console.log("\n📦 Building legacy JSON backup...");

  const kvRows = db.prepare("SELECT namespace, key, value FROM key_value").all();
  const settings = {};
  for (const { namespace, key, value } of kvRows) {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    try {
      settings[fullKey] = JSON.parse(value);
    } catch {
      settings[fullKey] = value;
    }
  }

  const metaRows = db.prepare("SELECT key, value FROM db_meta").all();
  for (const { key, value } of metaRows) {
    settings[`_meta.${key}`] = value;
  }

  const providerConnections = db
    .prepare("SELECT * FROM provider_connections")
    .all()
    .map(rowToLegacy);

  const providerNodes = db
    .prepare("SELECT * FROM provider_nodes")
    .all()
    .map(rowToLegacy);

  const combos = db
    .prepare("SELECT * FROM combos")
    .all()
    .map((r) => {
      const legacy = rowToLegacy(r);
      if (legacy.data && typeof legacy.data === "string") {
        try {
          const parsed = JSON.parse(legacy.data);
          legacy.models = parsed.models || [];
          legacy.strategy = parsed.strategy || "fallback";
          legacy.config = parsed.config || {};
          if (parsed.context_length) legacy.contextLength = parsed.context_length;
          if (parsed.version) legacy.version = parsed.version;
          if (parsed.isActive !== undefined) legacy.isActive = parsed.isActive;
          if (parsed.repairNote) legacy.repairNote = parsed.repairNote;
        } catch { /* keep raw data */ }
      }
      delete legacy.data;
      return legacy;
    });

  const apiKeys = db
    .prepare("SELECT * FROM api_keys")
    .all()
    .map(rowToLegacy);

  const usageHistory = db.prepare("SELECT * FROM usage_history").all();
  const domainBudgets = db.prepare("SELECT * FROM domain_budgets").all();

  const legacyBackup = {
    settings,
    providerConnections,
    providerNodes,
    combos,
    apiKeys,
    usageHistory,
    domainCostHistory: [],
    domainBudgets,
    _meta: {
      version: "omniroute-v3-legacy-export",
      exportedAt: new Date().toISOString(),
      source: "omni-migrate",
      sourceDb: basename(dbPath),
      platform: platform(),
      arch: arch(),
    },
  };

  // ── Part 2: SQL dump ──
  console.log("🗄️  Building SQL dump...");

  const exportableTables = tables.filter((t) => !SKIP_TABLES.has(t));
  const sqlStatements = [];

  for (const tableName of exportableTables) {
    const info = db.prepare(`PRAGMA table_info("${tableName}")`).all();
    const cols = info.map((c) => c.name);
    const rows = db.prepare(`SELECT * FROM "${tableName}"`).all();
    if (rows.length === 0) continue;

    sqlStatements.push(`-- Table: ${tableName} (${rows.length} rows)`);
    sqlStatements.push(`DELETE FROM "${tableName}";`);

    for (const row of rows) {
      const values = cols.map((c) => sqlEscape(row[c]));
      sqlStatements.push(
        `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${values.join(", ")});`
      );
    }
    sqlStatements.push("");
  }

  // ── Write files ──
  mkdirSync(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = join(outDir, `omniroute-migrate-${ts}.json`);
  const sqlPath = join(outDir, `omniroute-migrate-${ts}.sql`);

  writeFileSync(jsonPath, JSON.stringify(legacyBackup, null, 2), "utf8");
  writeFileSync(sqlPath, sqlStatements.join("\n"), "utf8");

  const sqlTableCount = exportableTables.filter(
    (t) => db.prepare(`SELECT count(*) as c FROM "${t}"`).get().c > 0
  ).length;

  console.log(`\n✅ Export complete:`);
  console.log(`   JSON: ${jsonPath}`);
  console.log(`   SQL:  ${sqlPath}`);
  console.log(`\n   Stats:`);
  console.log(`     Settings:    ${Object.keys(settings).length} keys`);
  console.log(`     Connections: ${providerConnections.length}`);
  console.log(`     Nodes:       ${providerNodes.length}`);
  console.log(`     Combos:      ${combos.length}`);
  console.log(`     API Keys:    ${apiKeys.length}`);
  console.log(`     SQL tables:  ${sqlTableCount} with data`);
  console.log(`     SQL rows:    ${sqlStatements.filter((l) => l.startsWith("INSERT")).length}`);

  db.close();
  return { jsonPath, sqlPath };
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function deleteDatabase(dbPath, force) {
  if (!existsSync(dbPath)) {
    console.log(`ℹ️  Database not found: ${dbPath} (already deleted?)`);
    return;
  }

  const confirmed = await confirm(`⚠️  Delete database: ${dbPath}?`, force);
  if (!confirmed) {
    console.log("❌ Aborted.");
    process.exit(1);
  }

  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      unlinkSync(p);
      console.log(`🗑️  Deleted: ${p}`);
    }
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpPost(host, port, path, body, contentType = "application/json") {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: host,
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let resBody = "";
        res.on("data", (c) => (resBody += c));
        res.on("end", () => resolve({ status: res.statusCode, body: resBody }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpGet(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: host, port, path, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(host, port, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await httpGet(host, port, "/v1/models");
      if (res.status === 200) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ─── API Import ──────────────────────────────────────────────────────────────

async function importData(fileDir, host, port) {
  const jsonFiles = readdirSync(fileDir)
    .filter((f) => f.startsWith("omniroute-migrate-") && f.endsWith(".json"))
    .sort()
    .reverse();

  if (jsonFiles.length === 0) {
    console.error(`❌ No omniroute-migrate-*.json found in ${fileDir}`);
    process.exit(1);
  }

  const jsonPath = join(fileDir, jsonFiles[0]);
  console.log(`📂 Import file: ${jsonPath}`);

  const legacy = JSON.parse(readFileSync(jsonPath, "utf8"));
  console.log(`   Settings:    ${Object.keys(legacy.settings || {}).length}`);
  console.log(`   Connections: ${(legacy.providerConnections || []).length}`);
  console.log(`   Nodes:       ${(legacy.providerNodes || []).length}`);
  console.log(`   Combos:      ${(legacy.combos || []).length}`);
  console.log(`   API Keys:    ${(legacy.apiKeys || []).length}`);

  // Check SQL availability
  const sqlFiles = readdirSync(fileDir)
    .filter((f) => f.startsWith("omniroute-migrate-") && f.endsWith(".sql"))
    .sort()
    .reverse();

  if (sqlFiles.length > 0) {
    console.log("\n📋 SQL dump available (recommended — no auth needed)");
    return { jsonPath, sqlAvailable: true, sqlPath: join(fileDir, sqlFiles[0]) };
  }

  // API import
  console.log(`\n🔍 Checking server at ${host}:${port}...`);
  const alive = await waitForServer(host, port, 10000);
  if (!alive) {
    console.error(`❌ Server not reachable at ${host}:${port}`);
    process.exit(1);
  }
  console.log("   ✅ Server is up");

  console.log("\n📥 Importing via /api/settings/import-json...");
  const res = await httpPost(host, port, "/api/settings/import-json", legacy);
  const result = JSON.parse(res.body);

  if (res.status === 200 && result.success) {
    console.log("✅ Import successful:");
    console.log(`   Connections: ${result.connections}`);
    console.log(`   Nodes:       ${result.nodes}`);
    console.log(`   Combos:      ${result.combos}`);
    console.log(`   API Keys:    ${result.apiKeys}`);
  } else {
    console.error(`❌ Import failed (${res.status}):`, result);
    if (res.status === 401) {
      console.log("\n💡 Auth required. Use sql-import instead (server must be stopped).");
    }
    process.exit(1);
  }

  return result;
}

// ─── SQL Import ──────────────────────────────────────────────────────────────

function sqlImport(dbPath, fileDir) {
  if (!existsSync(dbPath)) {
    console.error(`❌ Database not found: ${dbPath}`);
    process.exit(1);
  }

  const sqlFiles = readdirSync(fileDir)
    .filter((f) => f.startsWith("omniroute-migrate-") && f.endsWith(".sql"))
    .sort()
    .reverse();

  if (sqlFiles.length === 0) {
    console.error(`❌ No omniroute-migrate-*.sql found in ${fileDir}`);
    process.exit(1);
  }

  const sqlPath = join(fileDir, sqlFiles[0]);
  console.log(`🗄️  SQL import: ${sqlPath}`);
  console.log(`   Target DB:  ${dbPath}`);

  const db = new DatabaseSync(dbPath, { open: true });

  // Build target schema map: table → Set of column names
  const targetSchema = {};
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
    targetSchema[name] = new Set(cols.map((c) => c.name));
  }

  const rawSql = readFileSync(sqlPath, "utf8");
  const lines = rawSql.split("\n");
  const fixedLines = [];
  let droppedCols = 0;

  for (const line of lines) {
    // DELETE FROM "table" — skip if table not in target
    const deleteMatch = line.match(/^DELETE FROM "(\w+)"/);
    if (deleteMatch) {
      const tbl = deleteMatch[1];
      if (!targetSchema[tbl]) {
        droppedCols++;
        continue;
      }
      fixedLines.push(line);
      continue;
    }

    // INSERT INTO "table" ("col1", "col2", ...) VALUES (...)
    const insertMatch = line.match(
      /^INSERT INTO "(\w+)" \(([^)]+)\) VALUES \((.+)\);?$/
    );
    if (!insertMatch) {
      fixedLines.push(line);
      continue;
    }

    const [, tableName, colsPart, valuesPart] = insertMatch;
    const srcCols = colsPart.split(", ").map((c) => c.replace(/"/g, "").trim());
    const srcVals = parseSqlValues(valuesPart);

    const tgtCols = targetSchema[tableName];
    if (!tgtCols) {
      console.log(`   ⚠️  Table "${tableName}" not in target — skipping`);
      droppedCols++;
      continue;
    }

    // Filter to only columns that exist in target, preserving order
    const kept = [];
    const keptVals = [];
    for (let i = 0; i < srcCols.length; i++) {
      if (tgtCols.has(srcCols[i])) {
        kept.push(`"${srcCols[i]}"`);
        keptVals.push(srcVals[i] ?? "NULL");
      } else {
        droppedCols++;
      }
    }

    if (kept.length === 0) continue;
    fixedLines.push(
      `INSERT INTO "${tableName}" (${kept.join(", ")}) VALUES (${keptVals.join(", ")});`
    );
  }

  if (droppedCols > 0) {
    console.log(`   🔄 Adapted schema: ${droppedCols} column(s) dropped (not in target)`);
  }

  const fixedSql = fixedLines.join("\n");
  const inserts = (fixedSql.match(/^INSERT /gm) || []).length;
  const deletes = (fixedSql.match(/^DELETE /gm) || []).length;
  console.log(`   Statements: ${deletes} DELETE + ${inserts} INSERT`);

  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN TRANSACTION");
    db.exec(fixedSql);
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys=ON");
    console.log("✅ SQL import complete");
  } catch (err) {
    console.error(`❌ SQL import failed: ${err.message}`);
    process.exit(1);
  }

  db.close();
}

/**
 * Parse SQL VALUES (...) content, splitting on commas that are NOT inside quotes.
 * Returns an array of value strings (with surrounding whitespace trimmed).
 */
function parseSqlValues(valuesPart) {
  const vals = [];
  let depth = 0; // parentheses
  let inStr = false;
  let strChar = null;
  let current = "";

  for (let i = 0; i < valuesPart.length; i++) {
    const ch = valuesPart[i];

    if (inStr) {
      current += ch;
      if (ch === strChar && valuesPart[i - 1] !== "\\") inStr = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inStr = true;
      strChar = ch;
      current += ch;
      continue;
    }

    if (ch === "(") depth++;
    if (ch === ")") depth--;

    if (ch === "," && depth === 0) {
      vals.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  vals.push(current.trim());
  return vals;
}

// ─── Detect ──────────────────────────────────────────────────────────────────

function showDetection() {
  const { npmDir, electronDir } = detectDataDirs();
  const npmDb = findDbFile(npmDir);
  const electronDb = findDbFile(electronDir);

  console.log("🔍 OmniRoute database detection\n");
  console.log(`   Platform: ${platform()} ${arch()}\n`);

  console.log("   npm CLI:");
  console.log(`     Data dir:  ${npmDir}`);
  console.log(`     Database:  ${npmDb || "NOT FOUND"}${npmDb ? ` (${(readFileSync(npmDb).length / 1024 / 1024).toFixed(1)} MB)` : ""}`);

  console.log("\n   Electron:");
  console.log(`     Data dir:  ${electronDir}`);
  console.log(`     Database:  ${electronDb || "NOT FOUND"}${electronDb ? ` (${(readFileSync(electronDb).length / 1024 / 1024).toFixed(1)} MB)` : ""}`);

  if (npmDb || electronDb) {
    console.log("\n   Recommended command:");
    const target = electronDb && !npmDb ? "electron" : "npm";
    console.log(`     node --experimental-sqlite omni-migrate.mjs export --target ${target}`);
  } else {
    console.log("\n   ℹ️  No database files found. Export will work once data exists.");
  }
}

// ─── Migrate (all-in-one) ────────────────────────────────────────────────────

async function migrate(dbPath, host, port, outDir, force, target) {
  console.log("🚀 OmniRoute Migration Tool\n");
  console.log(`   Target: ${target} (${dbPath})`);
  console.log(`   Platform: ${platform()} ${arch()}\n`);

  // Step 1: Export
  console.log("═══ Step 1/3: Export ═══");
  const { jsonPath } = exportDatabase(dbPath, outDir);
  const dir = dirname(jsonPath);

  // Step 2: Delete
  console.log("\n═══ Step 2/3: Delete ═══");
  await deleteDatabase(dbPath, force);

  // Step 3: SQL import (while DB is gone, server is not running)
  // This is the critical order: import FIRST, then start server.
  // If we start the server first, it creates an empty DB and our import is lost.
  console.log("\n═══ Step 3/3: SQL Import ═══");
  console.log("   ℹ️  Importing data before starting server (so data persists)...\n");

  // The DB was just deleted. Create an empty one for sql-import.
  // OmniRoute's migrations will run on next server start and extend the schema.
  // sql-import only writes data into existing tables, so we need a DB with the schema.
  // Strategy: let the server create the schema once, stop it, then import.

  if (target === "npm") {
    // Start server to create schema (empty DB)
    console.log("   Starting server to create database schema...");
    const r = await omnirouteCmd("serve --port " + port + " --no-open --daemon");
    if (!r.ok) {
      console.log("   ⚠️  Could not auto-start. Start OmniRoute manually.");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await new Promise((resolve) => {
        rl.question("   Press Enter when server is running: ", () => { rl.close(); resolve(); });
      });
    }
    console.log("   Waiting for schema creation...");
    const alive = await waitForServer(host, port, 30000);
    if (alive) console.log("   ✅ Schema created");
    else console.log("   ⚠️  Server not detected, continuing...");

    // Stop server
    console.log("   Stopping server for SQL import...");
    await omnirouteCmd("stop");
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    // Electron: user must start/stop manually
    console.log("   ➜ Start Electron once to create the database schema, then close it.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => {
      rl.question("   Press Enter when Electron has been started and closed: ", () => { rl.close(); resolve(); });
    });
  }

  // Now import SQL into the schema-ified but empty DB
  sqlImport(dbPath, dir);

  // Restart with data
  console.log("\n   Starting server with imported data...");
  if (target === "npm") {
    await omnirouteCmd("serve --port " + port + " --no-open --daemon");
    const ok = await waitForServer(host, port, 30000);
    if (ok) console.log("   ✅ Server is running with all data restored");
  } else {
    console.log("   ➜ Start Electron now. All data will be loaded.");
  }

  console.log("\n🎉 Migration complete!");
}

// ─── Help ────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
omni-migrate — Export & import OmniRoute database

Works with both npm CLI and Electron desktop app.
Cross-platform: Windows, Linux, macOS.

COMMANDS:
  detect      Show detected database paths
  export      Read DB → write JSON + SQL files
  delete      Remove old DB (+ WAL/SHM)
  sql-import  Write SQL into DB (server/ Electron must be stopped)
  import      POST JSON via API (server must be running)
  migrate     All-in-one guided workflow

OPTIONS:
  --target <npm|electron>  Which install to target (auto-detected if omitted)
  --db <path>              Override database path
  --out <dir>              Export output directory (default: <db-dir>/migrate-export)
  --host <h>               Server host (default: localhost)
  --port <p>               Server port (default: 20128)
  --file <dir>             Import file directory
  --force / -y             Skip confirmation prompts

REQUIREMENTS:
  Node.js >= 22 with --experimental-sqlite flag

EXAMPLES — npm CLI:
  node --experimental-sqlite omni-migrate.mjs detect
  node --experimental-sqlite omni-migrate.mjs export
  node --experimental-sqlite omni-migrate.mjs delete -y
  node --experimental-sqlite omni-migrate.mjs sql-import
  node --experimental-sqlite omni-migrate.mjs migrate --force

EXAMPLES — Electron:
  node --experimental-sqlite omni-migrate.mjs detect
  node --experimental-sqlite omni-migrate.mjs export --target electron
  node --experimental-sqlite omni-migrate.mjs delete --target electron -y
  (start Electron → creates empty DB)
  node --experimental-sqlite omni-migrate.mjs sql-import --target electron
  (restart Electron)
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const command = process.argv[2];
const opts = parseArgs(process.argv);

if (opts.help || !command) {
  showHelp();
  process.exit(0);
}

if (command === "detect") {
  showDetection();
  process.exit(0);
}

const target = opts.target || detectTarget(opts.target);
const dataDir = getDataDir(target);
const dbPath = opts.db || join(dataDir, "storage.sqlite");
const outDir = opts.out || join(dataDir, "migrate-export");
const host = opts.host || DEFAULT_HOST;
const port = opts.port || DEFAULT_PORT;
const fileDir = opts.file || outDir;

switch (command) {
  case "export":
    exportDatabase(dbPath, outDir);
    break;
  case "delete":
    await deleteDatabase(dbPath, opts.force);
    break;
  case "import":
    await importData(fileDir, host, port);
    break;
  case "sql-import":
    sqlImport(dbPath, fileDir);
    break;
  case "migrate":
    await migrate(dbPath, host, port, outDir, opts.force, target);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    showHelp();
    process.exit(1);
}
