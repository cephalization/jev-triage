import { createEmulator } from "emulate";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { fetchGithubUser, resolveAccount, userIdFor } from "../src/github/account.ts";

describe("resolveAccount", () => {
  const admins = ["Alice", "bob"].map((s) => s.toLowerCase());

  test("env admins are admins regardless of invites", () => {
    expect(resolveAccount("alice", { adminLogins: admins, invite: null })).toEqual({
      ok: true,
      role: "admin",
      viaInvite: false,
    });
    expect(resolveAccount("BOB", { adminLogins: admins, invite: { role: "member" } })).toEqual({
      ok: true,
      role: "admin",
      viaInvite: false,
    });
  });

  test("an invite grants its role", () => {
    expect(resolveAccount("carol", { adminLogins: admins, invite: { role: "member" } })).toEqual({
      ok: true,
      role: "member",
      viaInvite: true,
    });
    expect(resolveAccount("carol", { adminLogins: admins, invite: { role: "admin" } })).toEqual({
      ok: true,
      role: "admin",
      viaInvite: true,
    });
  });

  test("nobody else gets in", () => {
    expect(resolveAccount("dave", { adminLogins: admins, invite: null })).toEqual({
      ok: false,
      reason: "not_invited",
    });
    expect(resolveAccount("  ", { adminLogins: [], invite: { role: "admin" } }).ok).toBe(false);
  });

  test("ids come from the GitHub numeric id", () => {
    expect(userIdFor(583231)).toBe("gh_583231");
  });
});

describe("fetchGithubUser against the emulator", () => {
  let github: Awaited<ReturnType<typeof createEmulator>>;
  beforeAll(async () => {
    github = await createEmulator({
      service: "github",
      port: 4011,
      seed: {
        tokens: {
          gho_test_token_admin: { login: "admin" },
          gho_test_token_octocat: { login: "octocat" },
        },
        github: { users: [{ login: "admin" }, { login: "octocat" }] },
      },
    });
  });
  afterAll(() => github.close());

  test("a seeded token resolves to its user", async () => {
    const u = await fetchGithubUser(github.url, "gho_test_token_admin");
    expect(u.login).toBe("admin");
    expect(typeof u.id).toBe("number");
  });

  test("each seeded token maps to its own user", async () => {
    const a = await fetchGithubUser(github.url, "gho_test_token_admin");
    const b = await fetchGithubUser(github.url, "gho_test_token_octocat");
    expect([a.login, b.login]).toEqual(["admin", "octocat"]);
    expect(a.id).not.toBe(b.id);
  });
});
