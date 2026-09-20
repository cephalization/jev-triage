import { DurableObject } from "cloudflare:workers";
import { cut } from "@triage/triage";
import { contentHash } from "./diff.ts";
import { isText, skipReason, stripRoot } from "./snapshot-rules.ts";
import { readTar } from "./tar.ts";

/**
 * A repository at one commit, as text the agent can list, read and grep. One cell per
 * `owner/repo@sha`, filled once from GitHub's tarball and shared by every review of that head.
 * Binary files, vendored trees and lockfiles are left out; what remains is a SQLite table of
 * paths and contents, so the cell's storage size is the honest cost of the snapshot.
 */

export interface SnapshotEnv {
  REPO_INDEX: DurableObjectNamespace<import("./index.ts").RepoIndex>;
}

export interface SnapshotStats {
  owner: string;
  repo: string;
  sha: string;
  status: "empty" | "loading" | "ready" | "failed";
  files: number;
  bytes: number;
  dbBytes: number;
  error: string | null;
  createdAt: number | null;
}

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** Bumped when the tables change shape; an older snapshot reloads from GitHub on first use. */
const FORMAT = "3";

export class RepoSnapshot extends DurableObject<SnapshotEnv> {
  #loading: Promise<SnapshotStats> | null = null;

  constructor(ctx: DurableObjectState, env: SnapshotEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS file (path TEXT PRIMARY KEY, size INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT);
       CREATE TABLE IF NOT EXISTS skipped (path TEXT PRIMARY KEY, size INTEGER NOT NULL, reason TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    const cols = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(file)").toArray();
    if (!cols.some((c) => c.name === "hash"))
      ctx.storage.sql.exec("ALTER TABLE file ADD COLUMN hash TEXT");
  }

  #meta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  #setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  stats(): SnapshotStats {
    const agg = this.ctx.storage.sql
      .exec<{ n: number; bytes: number | null }>(
        "SELECT count(*) AS n, sum(size) AS bytes FROM file",
      )
      .one();
    return {
      owner: this.#meta("owner") ?? "",
      repo: this.#meta("repo") ?? "",
      sha: this.#meta("sha") ?? "",
      status: (this.#meta("status") as SnapshotStats["status"] | null) ?? "empty",
      files: agg.n,
      bytes: agg.bytes ?? 0,
      dbBytes: this.ctx.storage.sql.databaseSize,
      error: this.#meta("error"),
      createdAt: this.#meta("created_at") ? Number(this.#meta("created_at")) : null,
    };
  }

  /** Fill from GitHub once; concurrent callers share the same load. A snapshot in an older shape reloads. */
  async ensure(args: {
    owner: string;
    repo: string;
    sha: string;
    apiBase: string;
    token: string | null;
  }): Promise<SnapshotStats> {
    const current = this.stats();
    if (current.status === "ready" && this.#meta("format") === FORMAT) return current;
    if (this.#loading) return this.#loading;
    this.#loading = this.#load(args).finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #load(args: {
    owner: string;
    repo: string;
    sha: string;
    apiBase: string;
    token: string | null;
  }): Promise<SnapshotStats> {
    this.#setMeta("owner", args.owner);
    this.#setMeta("repo", args.repo);
    this.#setMeta("sha", args.sha);
    this.#setMeta("status", "loading");
    this.ctx.storage.sql.exec("DELETE FROM file");
    this.ctx.storage.sql.exec("DELETE FROM skipped");
    const t0 = Date.now();
    try {
      const url = `${args.apiBase.replace(/\/+$/, "")}/repos/${args.owner}/${args.repo}/tarball/${args.sha}`;
      const res = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "typeful-triage-reviewer",
          ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
        },
      });
      if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for the tarball`);
      const gunzip = res.body.pipeThrough(new DecompressionStream("gzip"));
      let batch: { path: string; size: number; text: string }[] = [];
      let skipped: { path: string; size: number; reason: string }[] = [];
      const flush = () => {
        if (batch.length === 0 && skipped.length === 0) return;
        const rows = batch;
        const left = skipped;
        batch = [];
        skipped = [];
        this.ctx.storage.transactionSync(() => {
          for (const r of rows)
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO file (path, size, text, hash) VALUES (?, ?, ?, ?)",
              r.path,
              r.size,
              r.text,
              contentHash(r.text),
            );
          for (const r of left)
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO skipped (path, size, reason) VALUES (?, ?, ?)",
              r.path,
              r.size,
              r.reason,
            );
        });
      };
      await readTar(gunzip, {
        want: (rawPath, size) => {
          const path = stripRoot(rawPath);
          const reason = skipReason(path, size);
          // A file left out is remembered so a diff can still say it changed; an empty file
          // is remembered as such so a diff can show it created or emptied.
          if (reason !== null) skipped.push({ path, size, reason });
          return reason === null;
        },
        onEntry: (e) => {
          const path = stripRoot(e.path);
          if (!isText(e.bytes)) {
            skipped.push({ path, size: e.size, reason: "binary" });
            return;
          }
          batch.push({ path, size: e.size, text: decoder.decode(e.bytes) });
          if (batch.length >= 200) flush();
        },
      });
      flush();
      this.#setMeta("format", FORMAT);
      this.#setMeta("status", "ready");
      this.#setMeta("error", "");
      this.#setMeta("created_at", String(Date.now()));
      const s = this.stats();
      console.log(
        `[snapshot] ${args.owner}/${args.repo}@${args.sha.slice(0, 7)}: ${s.files} files, ${s.bytes} bytes, ${Date.now() - t0} ms`,
      );
      await this.#report(s);
      return s;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.#setMeta("status", "failed");
      this.#setMeta("error", error);
      const s = this.stats();
      await this.#report(s);
      return s;
    }
  }

  async #report(s: SnapshotStats) {
    const index = this.env.REPO_INDEX.get(this.env.REPO_INDEX.idFromName(`${s.owner}/${s.repo}`));
    await index.fetch("http://index/index/snapshot", {
      method: "POST",
      body: JSON.stringify(s),
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Files under a path prefix. Compared with substr, not LIKE: workerd caps LIKE patterns at a
   * few dozen characters ("LIKE or GLOB pattern too complex"), and agents ask for deep paths.
   */
  list(prefix: string, limit: number): { path: string; size: number }[] {
    const clean = prefix.replace(/^\.?\/+/, "");
    return this.ctx.storage.sql
      .exec<{ path: string; size: number }>(
        "SELECT path, size FROM file WHERE substr(path, 1, ?) = ? ORDER BY path LIMIT ?",
        clean.length,
        clean,
        limit,
      )
      .toArray();
  }

  /** Every kept file's path, size and hash, and every file left out, for diffing two snapshots. */
  manifest(): {
    files: [string, { size: number; hash: string }][];
    skipped: [string, { size: number; reason: string }][];
  } {
    const files = this.ctx.storage.sql
      .exec<{ path: string; size: number; hash: string }>("SELECT path, size, hash FROM file")
      .toArray()
      .map(
        (r) => [r.path, { size: r.size, hash: r.hash }] as [string, { size: number; hash: string }],
      );
    const skipped = this.ctx.storage.sql
      .exec<{ path: string; size: number; reason: string }>(
        "SELECT path, size, reason FROM skipped",
      )
      .toArray()
      .map(
        (r) =>
          [r.path, { size: r.size, reason: r.reason }] as [
            string,
            { size: number; reason: string },
          ],
      );
    return { files, skipped };
  }

  /** The text of many files at once, for a diff; paths not kept are absent. */
  texts(paths: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    // workerd's SQLite allows few bound parameters per statement; stay well under.
    for (let i = 0; i < paths.length; i += 50) {
      const chunk = paths.slice(i, i + 50);
      const rows = this.ctx.storage.sql
        .exec<{ path: string; text: string }>(
          `SELECT path, text FROM file WHERE path IN (${chunk.map(() => "?").join(",")})`,
          ...chunk,
        )
        .toArray();
      for (const r of rows) out[r.path] = r.text;
    }
    return out;
  }

  read(path: string): { path: string; size: number; text: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ path: string; size: number; text: string }>(
          "SELECT path, size, text FROM file WHERE path = ?",
          path,
        )
        .toArray()[0] ?? null
    );
  }

  /** Literal or regular-expression search; an instr prefilter keeps the JS scan small. */
  grep(
    pattern: string,
    glob: string | null,
    limit: number,
  ): { path: string; line: number; text: string }[] {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    const literal = /^[\w./-]+$/.test(pattern) ? pattern : null;
    const globRe = glob
      ? new RegExp(
          `^${glob
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, "\0")
            .replace(/\*/g, "[^/]*")
            .replace(/\0/g, ".*")}$`,
        )
      : null;
    const rows = this.ctx.storage.sql
      .exec<{ path: string; text: string }>(
        literal
          ? "SELECT path, text FROM file WHERE instr(text, ?) > 0 ORDER BY path LIMIT 400"
          : "SELECT path, text FROM file ORDER BY path",
        ...(literal ? [literal] : []),
      )
      .toArray();
    const out: { path: string; line: number; text: string }[] = [];
    for (const r of rows) {
      if (globRe && !globRe.test(r.path)) continue;
      const lines = r.text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i]!)) {
          out.push({ path: r.path, line: i + 1, text: cut(lines[i]!, 200) });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  async clear(): Promise<void> {
    const s = this.stats();
    await this.ctx.storage.deleteAll();
    const index = this.env.REPO_INDEX.get(this.env.REPO_INDEX.idFromName(`${s.owner}/${s.repo}`));
    await index.fetch(`http://index/index/snapshot/${s.sha}`, { method: "DELETE" });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tail = url.pathname.split("/").at(-1);
    if (request.method === "DELETE") {
      await this.clear();
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && tail !== "texts") {
      const body = (await request.json()) as {
        owner: string;
        repo: string;
        sha: string;
        apiBase: string;
        token: string | null;
      };
      return Response.json(await this.ensure(body));
    }
    if (tail === "manifest") return Response.json(this.manifest());
    if (tail === "texts") {
      const body = (await request.json().catch(() => ({}))) as { paths?: unknown };
      const paths = Array.isArray(body.paths)
        ? body.paths.filter((p): p is string => typeof p === "string")
        : [];
      return Response.json(this.texts(paths));
    }
    if (tail === "file") {
      const path = url.searchParams.get("path") ?? "";
      const row = this.read(path);
      return row ? Response.json(row) : Response.json({ error: "no such file" }, { status: 404 });
    }
    if (tail === "list")
      return Response.json(
        this.list(
          url.searchParams.get("prefix") ?? "",
          Number(url.searchParams.get("limit") ?? 200),
        ),
      );
    if (tail === "grep")
      return Response.json(
        this.grep(
          url.searchParams.get("q") ?? "",
          url.searchParams.get("glob"),
          Number(url.searchParams.get("limit") ?? 50),
        ),
      );
    return Response.json(this.stats());
  }
}
