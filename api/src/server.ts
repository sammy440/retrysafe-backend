import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`retrysafe api listening on http://localhost:${info.port} (origins: ${config.allowedOrigins.join(", ")})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
