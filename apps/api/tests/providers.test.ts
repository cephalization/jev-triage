import { describe, expect, test } from "vite-plus/test";
import { authHeaders, badHeaderChar, KINDS, parseModels } from "../src/providers/catalog.ts";
import { decrypt, deriveKey, encrypt, hint } from "../src/providers/crypto.ts";

describe("provider key encryption", () => {
  const key = deriveKey("test-secret");

  test("round-trips and never stores the plaintext", () => {
    const sealed = encrypt("sk-ant-1234567890abcdef", key);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("sk-ant");
    expect(decrypt(sealed, key)).toBe("sk-ant-1234567890abcdef");
  });

  test("a different secret cannot open it", () => {
    const sealed = encrypt("sk-x", key);
    expect(() => decrypt(sealed, deriveKey("other"))).toThrow();
  });

  test("two seals of the same key differ (fresh iv)", () => {
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  test("hint shows only the tail", () => {
    expect(hint("sk-ant-1234567890abcdef")).toBe("…cdef");
    expect(hint("abc")).toBe("set");
  });
});

describe("model catalog", () => {
  test("every kind has a label and key env; only compatible lacks a base URL", () => {
    for (const [kind, info] of Object.entries(KINDS)) {
      expect(info.label).toBeTruthy();
      expect(info.keyEnv).toMatch(/_API_KEY$/);
      expect(info.baseUrl === null).toBe(kind === "openai-compatible");
    }
  });

  test("anthropic authenticates with its own header, others with a bearer", () => {
    expect(authHeaders("anthropic", "k")).toMatchObject({ "x-api-key": "k" });
    expect(authHeaders("openai", "k")).toEqual({ authorization: "Bearer k" });
  });

  test("parseModels reads the three response shapes and sorts by id", () => {
    expect(
      parseModels({
        data: [
          { id: "gpt-b" },
          { id: "claude-a", display_name: "Claude A" },
          { id: "or/x", name: "OR X" },
          { nope: true },
        ],
      }),
    ).toEqual([
      { id: "claude-a", label: "Claude A" },
      { id: "gpt-b", label: "gpt-b" },
      { id: "or/x", label: "OR X" },
    ]);
    expect(parseModels({})).toEqual([]);
    expect(parseModels(null)).toEqual([]);
  });
});

describe("key input", () => {
  test("a key pasted from a terminal box is refused with the character named", () => {
    expect(badHeaderChar("sk-ant-abc123")).toBeNull();
    expect(badHeaderChar("sk-ant-abc\u2502123")).toBe("\u2502");
    expect(badHeaderChar("sk-ant-abc\u00a0123")).toBe("\u00a0");
    expect(badHeaderChar("sk-ant-abc 123")).toBe(" ");
  });
});
