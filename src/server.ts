import { createApp } from "./app.js";
import { createFirebaseTokenVerifier } from "./auth/firebaseTokenVerifier.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp({
  config,
  tokenVerifier: createFirebaseTokenVerifier(config.firebaseProjectId),
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "server_started",
      service: "drawsy-ai-backend",
      env: config.env,
      host: config.host,
      port: config.port,
    }),
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(
    JSON.stringify({ level: "info", message: "server_stopping", signal }),
  );
  server.close((error) => {
    if (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "server_shutdown_failed",
          error: error.message,
        }),
      );
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
