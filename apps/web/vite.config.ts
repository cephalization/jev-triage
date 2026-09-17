import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3939", changeOrigin: true } },
  },
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
