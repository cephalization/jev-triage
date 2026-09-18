import { DurableObject } from "cloudflare:workers";
import { isText, stripRoot, wanted } from "./snapshot-rules.ts";
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

export class RepoSnapshot extends DurableObject<SnapshotEnv> {
  #loading: Promise<SnapshotStats> | null = null;

  constructor(ctx: DurableObjectState, env: SnapshotEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS file (path TEXT PRIMARY KEY, size INTEGER NOT NULL, text TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
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

  /** Fill from GitHub once; concurrent callers share the same load. */
  async ensure(args: {
    owner: string;
    repo: string;
    sha: string;
    apiBase: string;
    token: string | null;
  }): Promise<SnapshotStats> {
    const current = this.stats();
    if (current.status === "ready") return current;
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
      const flush = () => {
        if (batch.length === 0) return;
        const rows = batch;
        batch = [];
        this.ctx.storage.transactionSync(() => {
          for (const r of rows)
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO file (path, size, text) VALUES (?, ?, ?)",
              r.path,
              r.size,
              r.text,
            );
        });
      };
      await readTar(gunzip, {
        want: (path, size) => wanted(stripRoot(path), size),
        onEntry: (e) => {
          if (!isText(e.bytes)) return;
          batch.push({ path: stripRoot(e.path), size: e.size, text: decoder.decode(e.bytes) });
          if (batch.length >= 200) flush();
        },
      });
      flush();
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
          out.push({ path: r.path, line: i + 1, text: lines[i]!.slice(0, 200) });
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
    if (request.method === "POST") {
      const body = (await request.json()) as {
        owner: string;
        repo: string;
        sha: string;
        apiBase: string;
        token: string | null;
      };
      return Response.json(await this.ensure(body));
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
