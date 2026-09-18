import { describe, expect, test } from "vite-plus/test";
import { PULLS_DEFAULTS, pullsSearch, TRIAGE_DEFAULTS, triageSearch } from "./search.ts";

describe("search schemas", () => {
  test("empty input yields the defaults a fresh visit uses", () => {
    expect(TRIAGE_DEFAULTS).toEqual({
      state: "open",
      cat: "all",
      mine: false,
      done: false,
      q: "",
      sort: "updated",
      dir: "desc",
      group: true,
    });
    expect(PULLS_DEFAULTS.by).toBe("list");
  });

  test("bad values are rejected rather than coerced into nonsense", () => {
    expect(triageSearch.safeParse({ state: "weird" }).success).toBe(false);
    expect(pullsSearch.safeParse({ sort: "nope" }).success).toBe(false);
  });

  test("partial input keeps the rest at defaults", () => {
    expect(triageSearch.parse({ q: "crash", group: false })).toMatchObject({
      q: "crash",
      group: false,
      state: "open",
    });
  });
});
