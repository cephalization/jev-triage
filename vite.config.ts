import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
    tasks: {
      // Long-running processes: never cached.
      "dev:api": { command: "vp run @triage/api#dev", cache: false },
      "dev:web": { command: "vp run @triage/web#dev", cache: false },
      "dev:zero": {
        command: "vpx zero-cache-dev",
        cache: false,
      },
      migrate: { command: "vp run @triage/api#migrate", cache: false },
      emulate: { command: "vp run @triage/api#emulate", cache: false },
      "dev:emulate": { command: "node scripts/dev.mjs --emulate", cache: false },
      typecheck: { command: "tsc -b", cache: true },
    },
  },
});
