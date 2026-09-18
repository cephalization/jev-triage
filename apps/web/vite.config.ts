import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // Ports come from the environment so a second stack can run beside the default one.
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": { target: `http://localhost:${process.env.API_PORT ?? 3939}`, changeOrigin: true },
    },
  },
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
