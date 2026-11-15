import { createApp, VERSION } from "./app.js";
import { loadConfig } from "./config.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`[config] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const app = createApp({ config });
const server = app.listen(config.port, config.host, () => {
  console.log(`${config.serviceName} v${VERSION} listening on ${config.host}:${config.port}`);
  console.log(`Public URL: ${config.publicUrl.origin}  ·  MCP endpoint: ${new URL("/mcp", config.publicUrl).href}`);
  if (config.ahEnabled) console.log(`Albert Heijn MCP endpoint: ${new URL("/ah/mcp", config.publicUrl).href}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
