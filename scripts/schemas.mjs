import { readFileSync, writeFileSync } from "node:fs";
import {
  configSchema,
  relayConfigSchema,
} from "../packages/core/dist/config-schema.js";

for (const [name, schema] of [
  ["journeygap", configSchema],
  ["relay", relayConfigSchema],
]) {
  const path = new URL(
    `../packages/core/schema/${name}.schema.json`,
    import.meta.url,
  );
  const content = `${JSON.stringify(schema, null, 2)}\n`;
  if (process.argv.includes("--write")) writeFileSync(path, content);
  else if (readFileSync(path, "utf8") !== content)
    throw new Error(`Stale schema: ${name}`);
}
