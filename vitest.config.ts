import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file boots PGlite (WASM Postgres) once in its first beforeEach.
    // That takes 3-6s when files run in parallel on a busy machine, close to
    // the default 10s hook timeout. Tests themselves keep the 5s default.
    hookTimeout: 30_000,
  },
});
