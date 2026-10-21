import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/worker.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  // @retrysafe/core is workspace source; bundle it. Its npm deps stay external.
  noExternal: ["@retrysafe/core"],
});
