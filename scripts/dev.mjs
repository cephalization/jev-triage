// Starts Postgres (docker compose), runs migrations, then api + zero-cache + web together.
// Usage: vp run dev   (Ctrl-C stops everything). Env comes from the root .env.
// With --emulate (vp run dev:emulate) the emulate.dev GitHub emulator starts first and sign-in
// is pointed at it, so no GitHub OAuth app or account is needed; see scripts/emulate-env.mjs.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { EMULATED_ADMIN_TOKEN, EMULATOR_URL, emulateEnv } from "./emulate-env.mjs";

const root = new URL("..", import.meta.url).pathname;
const emulate = process.argv.includes("--emulate");

function loadEnv(path) {
  const out = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`[dev] Node 24 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}
if (!existsSync(`${root}.env`)) {
  console.error(
    "[dev] No .env found. Run `cp .env.example .env`, set TYPESAFE_API_KEY, then `vp run dev`.",
  );
  process.exit(1);
}

let env = { ...loadEnv(`${root}.env`), ...process.env };
if (emulate) env = emulateEnv(env);

const run = (name, cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env, ...opts });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[dev] ${name} exited with ${code}`);
  });
  return child;
};
const once = (name, cmd, args, opts) =>
  new Promise((resolve, reject) => {
    run(name, cmd, args, opts).on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed`)),
    );
  });

/** Poll until the emulator answers, so the login page never races it. */
async function waitFor(url, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

// The reviewer cell runs in Docker on a bundle built here; build before compose starts it.
await once("reviewer build", "pnpm", ["--filter", "@triage/reviewer", "build"]);
await once("docker", "docker", ["compose", "up", "-d", "--wait"]);
env.PHOENIX_COLLECTOR_ENDPOINT ||= "http://localhost:7006";
console.log(`[dev] Phoenix traces at ${env.PHOENIX_COLLECTOR_ENDPOINT}`);
env.REVIEW_CELL_URL ||= `http://127.0.0.1:${env.REVIEWER_PORT || "9876"}`;
console.log(`[dev] reviewer cell at ${env.REVIEW_CELL_URL} (docker)`);
await once("migrate", "pnpm", ["--filter", "@triage/api", "migrate"]);

const children = [];

// Rebuild the cell's bundle on every save; celld in Docker reloads it from the bind mount.
children.push(run("reviewer", "pnpm", ["--filter", "@triage/reviewer", "dev"]));

if (emulate) {
  children.push(run("emulate", "pnpm", ["--filter", "@triage/api", "emulate"]));
  if (!(await waitFor(`${EMULATOR_URL}/user`))) {
    console.error(`[dev] the GitHub emulator did not come up on ${EMULATOR_URL}`);
    process.exit(1);
  }
  console.log(
    `[dev] emulated GitHub at ${EMULATOR_URL}: sign in with the token ${EMULATED_ADMIN_TOKEN}, or through "Continue with GitHub" and pick a user. Sync still uses ${env.GITHUB_SYNC_API_URL}.`,
  );
}
children.push(
  run("api", "pnpm", ["--filter", "@triage/api", "dev"]),
  run("zero", "pnpm", ["--filter", "@triage/api", "zero"]),
  run("web", "pnpm", ["--filter", "@triage/web", "dev"]),
);
const stop = () => {
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
