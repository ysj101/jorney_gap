import { createReadStream, existsSync, statSync } from "node:fs";
import {
  MAX_OTLP_BYTES,
  parseOtlpJson,
  type RelayConfig,
} from "@journeygap/core";
import { EventStore } from "@journeygap/relay";
import { CliError } from "./config.js";

async function* lines(
  path: string,
): AsyncGenerator<{ line: number; text: string }> {
  let pending = Buffer.alloc(0);
  let number = 0;
  for await (const raw of createReadStream(path, { highWaterMark: 65536 })) {
    const chunk = raw as Buffer;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (pending.length + part.length > MAX_OTLP_BYTES)
        throw new CliError(
          `Line ${number + 1} exceeds 256 KiB; prior valid lines remain saved and retries deduplicate`,
        );
      pending = Buffer.concat([pending, part]);
      if (newline < 0) break;
      number++;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true })
          .decode(pending)
          .replace(/\r$/, "");
      } catch {
        throw new CliError(`Invalid UTF-8 at line ${number}`);
      }
      yield { line: number, text };
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
  }
  if (pending.length) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(pending);
    } catch {
      throw new CliError(`Invalid UTF-8 at line ${number + 1}`);
    }
    yield { line: number + 1, text };
  }
}

export async function importOtlp(
  input: string,
  database: string,
  config: RelayConfig,
  now = Date.now,
): Promise<{ lines: number; inserted: number; duplicates: number }> {
  const inputInfo = statSync(input);
  const databaseInfo = existsSync(database) ? statSync(database) : undefined;
  if (
    !inputInfo.isFile() ||
    input === database ||
    (databaseInfo &&
      databaseInfo.ino === inputInfo.ino &&
      databaseInfo.dev === inputInfo.dev)
  )
    throw new CliError(
      "Input must be an OTLP JSONL file distinct from the database",
    );
  const store = new EventStore(database, {
    retentionDays: config.retentionDays,
    ...(config.maxEvents === undefined ? {} : { maxEvents: config.maxEvents }),
    ...(config.maxDatabaseBytes === undefined
      ? {}
      : { maxDatabaseBytes: config.maxDatabaseBytes }),
    now,
  });
  const result = { lines: 0, inserted: 0, duplicates: 0 };
  try {
    store.setConfig(config);
    for await (const entry of lines(input)) {
      if (!entry.text.trim()) continue;
      try {
        const parsed = parseOtlpJson(entry.text, config, now());
        const inserted = store.insert(parsed.journeyEvents, "offline");
        result.lines++;
        result.inserted += inserted.inserted;
        result.duplicates += inserted.duplicates;
      } catch {
        throw new CliError(
          `Import stopped at line ${entry.line}; prior validated lines remain saved. Check schema, configured IDs or storage quota; reruns deduplicate`,
        );
      }
    }
    return result;
  } finally {
    store.close();
  }
}
