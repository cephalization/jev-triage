// Starts Postgres (docker compose), runs migrations, then api + zero-cache + web together.
// Usage: vp run dev   (Ctrl-C stops everything). Env comes from the root .env.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

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

const env = { ...loadEnv(`${root}.env`), ...process.env };

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

await once("postgres", "docker", ["compose", "up", "-d", "--wait"]);
await once("migrate", "pnpm", ["--filter", "@triage/api", "migrate"]);

const children = [
  run("api", "pnpm", ["--filter", "@triage/api", "dev"]),
  run("zero", "pnpm", ["--filter", "@triage/api", "zero"]),
  run("web", "pnpm", ["--filter", "@triage/web", "dev"]),
];
const stop = () => {
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
