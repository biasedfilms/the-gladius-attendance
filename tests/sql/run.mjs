// Applies the Supabase migrations to a throw-away PostgreSQL database and runs the
// SQL behaviour tests.
//
//   node tests/sql/run.mjs
//
// Uses DATABASE_URL when set (CI, must be a superuser connection to a server with
// pgcrypto); otherwise starts a temporary local cluster with initdb/pg_ctl.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const migrationsDir = path.join(root, "supabase/migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const [initMigration, ...laterMigrations] = migrations.map((f) => path.join(migrationsDir, f));

const files = [
  path.join(here, "00_supabase_stubs.sql"),
  initMigration,
  path.join(here, "01_seed_before_upgrade.sql"),
  ...laterMigrations,
  path.join(here, "10_attendance.test.sql"),
];

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

let cleanup = () => {};
let connection;

if (process.env.DATABASE_URL) {
  const dbName = `gladius_test_${process.pid}`;
  const admin = process.env.DATABASE_URL;
  run("psql", [admin, "-qc", `create database ${dbName}`], { stdio: "inherit" });
  const url = new URL(admin);
  url.pathname = `/${dbName}`;
  connection = [url.toString()];
  cleanup = () => run("psql", [admin, "-qc", `drop database if exists ${dbName}`], { stdio: "inherit" });
} else {
  const dir = mkdtempSync(path.join(tmpdir(), "gladius-pg-"));
  const data = path.join(dir, "data");
  const port = String(54000 + Math.floor(Math.random() * 1000));
  const init = run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"]);
  if (init.status !== 0) {
    console.error(init.stderr);
    console.error("initdb failed. Install PostgreSQL locally or set DATABASE_URL.");
    process.exit(1);
  }
  const start = run("pg_ctl", ["-D", data, "-l", path.join(dir, "log"), "-w", "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "start"]);
  if (start.status !== 0) {
    console.error(start.stdout, start.stderr);
    process.exit(1);
  }
  connection = ["-h", "127.0.0.1", "-p", port, "-U", "postgres", "postgres"];
  cleanup = () => {
    run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  };
}

let failed = false;
try {
  for (const file of files) {
    const result = run("psql", [...connection, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", file]);
    const label = path.relative(root, file);
    const lines = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => line.replace(/^psql:[^:]+:\d+: (WARNING|NOTICE):\s*/, "").trim())
      .filter((line) => /^ok - |ASSERTION|ERROR|ALL SQL TESTS PASSED/.test(line));
    if (result.status !== 0) {
      failed = true;
      console.error(`✗ ${label}`);
      console.error(result.stderr || result.stdout);
      break;
    }
    console.log(`✓ ${label}`);
    for (const line of lines) console.log(`    ${line}`);
  }
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
