import { parseArgs } from "node:util";
import { createApp } from "./app.js";
import { startupMessage } from "./startup.js";

/** Start a single Node process and release the data lease on normal process termination. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "serve") args.shift();
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8000" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("plan-quotas serve [--host 127.0.0.1] [--port 8000]");
    return;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("invalid port");
  process.umask(0o077);
  const app = createApp({
    log: (record) => console.log(JSON.stringify(record)),
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  try {
    await app.listen({ host: values.host!, port });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(`plan-quotas listening on ${values.host}:${port}`);
}
void main().catch((error: unknown) => {
  console.error(startupMessage(error));
  process.exitCode = 1;
});
