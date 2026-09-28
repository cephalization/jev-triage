import type { Transaction } from "@rocicorp/zero";
import { describe, expect, test, vi } from "vite-plus/test";
import { mutators } from "../src/mutators.ts";
import type { ZeroContext } from "../src/schema.ts";

const ctx: ZeroContext = {
  userID: "me",
  login: "cephalization",
  name: "Me",
  color: "blue",
  role: "member",
  avatarUrl: null,
};
const args = {
  repoId: "r",
  subjectKind: "issue" as const,
  subjectId: "i",
  subjectUpdatedAt: 100,
  status: "handled" as const,
};
function transaction(repo = "r") {
  const upsert = vi.fn();
  const remove = vi.fn();
  const run = vi.fn().mockResolvedValue({ id: "i", repo_id: repo, updated_at: 200 });
  return {
    tx: { run, mutate: { work_queue_state: { upsert, delete: remove } } } as unknown as Transaction,
    upsert,
    remove,
  };
}

describe("work queue mutator", () => {
  test("uses the authenticated person and preserves the version seen during a sync race", async () => {
    const { tx, upsert } = transaction();
    await mutators.workQueue.set.fn({ tx, ctx, args });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "me",
        subject_id: "i",
        subject_kind: "issue",
        subject_updated_at: 100,
        status: "handled",
        snoozed_until: null,
      }),
    );
  });
  test("rejects unauthenticated writes and subjects in a different repository", async () => {
    const { tx, upsert } = transaction("other");
    await expect(mutators.workQueue.set.fn({ tx, ctx: undefined, args })).rejects.toThrow(
      "Sign in",
    );
    await expect(mutators.workQueue.set.fn({ tx, ctx, args })).rejects.toThrow("repository");
    expect(upsert).not.toHaveBeenCalled();
  });
  test("restores only this person's item and computes a one-day snooze", async () => {
    const { tx, upsert, remove } = transaction();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      await mutators.workQueue.set.fn({
        tx,
        ctx,
        args: { ...args, subjectKind: "pull", status: "snoozed" },
      });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ subject_kind: "pull", snoozed_until: 86_401_000 }),
      );
      await mutators.workQueue.set.fn({ tx, ctx, args: { ...args, status: "ready" } });
      expect(remove).toHaveBeenCalledWith({
        user_id: "me",
        subject_kind: "issue",
        subject_id: "i",
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});
