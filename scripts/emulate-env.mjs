// Environment for `vp run dev:emulate`: sign-in goes to the emulate.dev GitHub emulator, sync
// keeps going to real GitHub unless the caller already pointed it elsewhere. Pure, so it can be
// tested without starting anything.

export const EMULATOR_URL = "http://localhost:4001";
export const EMULATED_ADMIN = "admin";
export const EMULATED_ADMIN_TOKEN = "gho_test_token_admin";

/** @param {Record<string, string | undefined>} base */
export function emulateEnv(base) {
  const admins = (base.ADMIN_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!admins.includes(EMULATED_ADMIN)) admins.push(EMULATED_ADMIN);
  return {
    ...base,
    GITHUB_API_URL: EMULATOR_URL,
    GITHUB_OAUTH_URL: EMULATOR_URL,
    GITHUB_SYNC_API_URL: base.GITHUB_SYNC_API_URL || "https://api.github.com",
    GITHUB_CLIENT_ID: "emulated-client-id",
    GITHUB_CLIENT_SECRET: "emulated-client-secret",
    ADMIN_GITHUB_LOGINS: admins.join(","),
  };
}
