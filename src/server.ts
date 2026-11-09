import { appConfig, llmConfig, serverConfig } from "./config/env.js";
import { LOG_MESSAGES, SHUTDOWN_SIGNALS } from "./constants.js";
import { connectDb, disconnectDb } from "./db.js";
import { createApp } from "./app.js";
import { GroqTriager } from "./llm/groq.js";

/** Composition root: the only file that wires concrete config + providers together. */
async function main() {
  await connectDb(serverConfig.mongoUri, serverConfig.mongoDbName);

  const app = createApp({ config: appConfig, triager: new GroqTriager(llmConfig) });

  const server = app.listen(serverConfig.port, () => {
    console.log(LOG_MESSAGES.SERVER_LISTENING(serverConfig.port, llmConfig.model));
  });

  const shutdown = (signal: string) => {
    console.log(LOG_MESSAGES.SHUTTING_DOWN(signal));
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, () => shutdown(signal));
}

main().catch((err) => {
  console.error(LOG_MESSAGES.STARTUP_FAILED, err);
  process.exit(1);
});
