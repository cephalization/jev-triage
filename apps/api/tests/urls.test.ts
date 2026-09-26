import { describe, expect, test } from "vite-plus/test";
import {
  apiPort,
  appUrl,
  isLocalUrl,
  reviewCellApiUrl,
  reviewCellPhoenixUrl,
  zeroCacheUrl,
} from "../src/urls.ts";

const railway = {
  PORT: "8080",
  RAILWAY_PUBLIC_DOMAIN: "triage.up.railway.app",
  RAILWAY_PRIVATE_DOMAIN: "triage-api.railway.internal",
};

describe("url derivation", () => {
  test("a bare environment is the local development stack", () => {
    expect(apiPort({})).toBe(3939);
    expect(appUrl({})).toBe("http://localhost:5173");
    expect(zeroCacheUrl({})).toBe("http://localhost:4848");
    expect(zeroCacheUrl({ ZERO_PORT: "4849" })).toBe("http://localhost:4849");
    expect(reviewCellApiUrl({})).toBe("http://host.docker.internal:3939");
    expect(reviewCellApiUrl({ API_PORT: "3940" })).toBe("http://host.docker.internal:3940");
  });

  test("Railway's own variables fill in the addresses", () => {
    expect(apiPort(railway)).toBe(8080);
    expect(appUrl(railway)).toBe("https://triage.up.railway.app");
    expect(reviewCellApiUrl(railway)).toBe("http://triage-api.railway.internal:8080");
  });

  test("explicit settings win and lose their trailing slash", () => {
    const env = { ...railway, APP_URL: "https://triage.example.com/", API_PORT: "3939" };
    expect(appUrl(env)).toBe("https://triage.example.com");
    expect(apiPort(env)).toBe(3939);
    expect(zeroCacheUrl({ ZERO_CACHE_URL: "https://zero.example.com/" })).toBe(
      "https://zero.example.com",
    );
    expect(reviewCellApiUrl({ ...railway, REVIEW_CELL_API_URL: "http://api:3939/" })).toBe(
      "http://api:3939",
    );
  });

  test("the cell shares the Phoenix address unless Phoenix is only on this machine", () => {
    expect(reviewCellPhoenixUrl({}, null)).toBe("http://phoenix:6006");
    expect(reviewCellPhoenixUrl({}, "http://localhost:7006")).toBe("http://phoenix:6006");
    expect(reviewCellPhoenixUrl({}, "http://phoenix.railway.internal:6006")).toBe(
      "http://phoenix.railway.internal:6006",
    );
    expect(reviewCellPhoenixUrl({ REVIEW_CELL_PHOENIX_URL: "http://p:1/" }, "http://x")).toBe(
      "http://p:1",
    );
  });

  test("local means loopback or the Docker host alias", () => {
    expect(isLocalUrl("http://127.0.0.1:9876")).toBe(true);
    expect(isLocalUrl("http://localhost:9876")).toBe(true);
    expect(isLocalUrl("http://[::1]:9876")).toBe(true);
    expect(isLocalUrl("http://host.docker.internal:9876")).toBe(true);
    expect(isLocalUrl("http://triage-reviewer.railway.internal:9876")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });
});
