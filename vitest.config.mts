import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Loads .env.local (if present) so integration tests can find TEST_DATABASE_URL.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No local env file (e.g. CI): tests read variables from the environment.
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: true,
  },
});
