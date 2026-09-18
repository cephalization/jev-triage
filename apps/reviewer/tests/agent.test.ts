import { describe, expect, test } from "vite-plus/test";
import { runTool, snapshotClient, type SnapshotClient } from "../src/agent.ts";

const snapshot: SnapshotClient = {
  list: async (prefix) => {
    if (prefix.length > 50) throw new Error("SQL error: LIKE or GLOB pattern too complex");
    return [{ path: `${prefix}a.ts`, size: 3 }];
  },
  read: async () => null,
  grep: async () => {
    throw new TypeError("boom");
  },
};
const host = { snapshot, callback: null, repo: "o/r", tracer: null };

describe("runTool", () => {
  test("a throwing tool becomes an error result the model can read, not a rejected run", async () => {
    const ok = await runTool(host, "list_files", { prefix: "src/" });
    expect(ok).toEqual({ text: "src/a.ts (3 bytes)", isError: false });
    const long = await runTool(host, "list_files", { prefix: "x".repeat(80) });
    expect(long.isError).toBe(true);
    expect(long.text).toBe("list_files failed: SQL error: LIKE or GLOB pattern too complex");
    const grep = await runTool(host, "grep", { pattern: "a" });
    expect(grep).toEqual({ text: "grep failed: boom", isError: true });
    expect(await runTool(host, "read_file", { path: "nope" })).toEqual({
      text: "no such file: nope",
      isError: true,
    });
  });

  test("the snapshot client carries the cell's error text", async () => {
    const client = snapshotClient(
      { fetch: async () => new Response("SQL error: step SQL cursor", { status: 500 }) },
      "/snapshots/o/r/sha",
    );
    await expect(client.list("src/", 10)).rejects.toThrow(
      "snapshot list answered 500: SQL error: step SQL cursor",
    );
  });
});
