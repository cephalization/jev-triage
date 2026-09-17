import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../db.ts";

/** Applies db/migrations/*.sql in name order, once each, tracked in schema_migrations. */
async function main() {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../db/migrations",
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set(
    (await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
  );
  for (const f of files) {
    if (applied.has(f)) continue;
    const body = await readFile(path.join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    console.log(`applied ${f}`);
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
