import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    reporters: ["default"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
