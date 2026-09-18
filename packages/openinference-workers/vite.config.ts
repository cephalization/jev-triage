import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
