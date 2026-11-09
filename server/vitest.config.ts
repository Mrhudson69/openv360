import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one Postgres database and reset the schema in
    // beforeAll, so they must not run in parallel across files.
    fileParallelism: false,
  },
});
