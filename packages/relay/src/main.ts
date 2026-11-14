#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { createRelay } from "./server.js";

try {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "journeygap.relay.json" },
      db: { type: "string", default: "./data/journeygap.db" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "4318" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "journeygap-relay --config journeygap.relay.json --db ./data/journeygap.db [--host 127.0.0.1] [--port 4318]",
    );
  } else {
    const port = Number(values.port);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !values.config ||
      !values.db ||
      !values.host ||
      statSync(values.config).size > 262144
    )
      throw new Error("Invalid options");
    const config: unknown = JSON.parse(readFileSync(values.config, "utf8"));
    const relay = createRelay({
      config,
      databasePath: values.db,
      adminToken: process.env.JOURNEYGAP_ADMIN_TOKEN ?? "",
    });
    try {
      console.log(
        `JourneyGap Relay listening at ${await relay.listen(port, values.host)}`,
      );
    } catch (error) {
      await relay.close();
      throw error;
    }
    const stop = () => {
      void relay.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
} catch {
  console.error(
    "Relay startup failed. Check arguments, configuration and file permissions.",
  );
  process.exitCode = 1;
}
