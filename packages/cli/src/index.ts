import { parseArgs } from "node:util";
import { CliError, loadConfiguration, localPath } from "./config.js";
import { importOtlp } from "./import.js";
import { initProject } from "./init.js";
import { formatReport, report } from "./report.js";
import { uninstallProject } from "./uninstall.js";

export type CliIo = {
  out: (text: string) => void;
  error: (text: string) => void;
};
export async function run(
  args: string[],
  io: CliIo = {
    out: (text) => console.log(text),
    error: (text) => console.error(text),
  },
  cwd = process.cwd(),
): Promise<number> {
  try {
    const command = args[0];
    if (!command || command === "--help" || command === "help") {
      io.out(
        "journeygap init [--endpoint https://receiver.example/v1/traces] [--approve-config-change HASH]\njourneygap uninstall\njourneygap import --input traces.jsonl --db journeygap.db [--config file]\njourneygap report --db journeygap.db --journey ID [--service ID] [--days 7 | --from ISO] [--to ISO] [--grace-minutes 0] [--format text|json] [--config file]",
      );
      return 0;
    }
    if (command === "uninstall") {
      if (args.length !== 1)
        throw new CliError("uninstall accepts no overwrite/force flags");
      const result = await uninstallProject(cwd);
      io.out(
        `JourneyGap ${result.status}; SDK dependency ${result.dependency}. Only owned integration files/imports were removed; inspect git diff --stat.`,
      );
      return 0;
    }
    if (command === "init") {
      let values: { endpoint?: string; "approve-config-change"?: string };
      try {
        ({ values } = parseArgs({
          args: args.slice(1),
          options: {
            endpoint: { type: "string" },
            "approve-config-change": { type: "string" },
          },
        }));
      } catch {
        throw new CliError(
          "Invalid init arguments; --force cannot overwrite existing files",
        );
      }
      const result = await initProject(cwd, {
        ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
        ...(values["approve-config-change"] === undefined
          ? {}
          : { approveConfigChange: values["approve-config-change"] }),
      });
      io.out(
        `JourneyGap ${result.status}. ${result.files.length ? `Changed: ${result.files.join(", ")}.` : "No files changed."} Navigation requires consent; connect app-specific outcomes using trackStep(). Review git diff --stat before committing.`,
      );
      return 0;
    }
    if (command !== "import" && command !== "report")
      throw new CliError("Unknown command; use --help");
    let values: Record<string, string | boolean | undefined>;
    try {
      ({ values } = parseArgs({
        args: args.slice(1),
        options:
          command === "import"
            ? {
                input: { type: "string" },
                db: { type: "string" },
                config: { type: "string" },
              }
            : {
                db: { type: "string" },
                config: { type: "string" },
                journey: { type: "string" },
                service: { type: "string" },
                days: { type: "string" },
                from: { type: "string" },
                to: { type: "string" },
                "grace-minutes": { type: "string" },
                format: { type: "string" },
              },
      }));
    } catch {
      throw new CliError("Invalid arguments; use --help");
    }
    const text = (key: string) =>
      typeof values[key] === "string" ? (values[key] as string) : undefined;
    const dbArg = text("db");
    if (!dbArg) throw new CliError("--db is required");
    const database = localPath(cwd, dbArg);
    const config = loadConfiguration(cwd, text("config"), database);
    if (command === "import") {
      const input = text("input");
      if (!input) throw new CliError("--input is required");
      const result = await importOtlp(localPath(cwd, input), database, config);
      io.out(
        `Imported ${result.lines} OTLP JSONL lines; inserted ${result.inserted} steps; duplicates ${result.duplicates}`,
      );
    } else {
      const journey = text("journey");
      if (!journey) throw new CliError("--journey is required");
      const format = text("format") ?? "text";
      if (format !== "text" && format !== "json")
        throw new CliError("--format must be text or json");
      const options = {
        journey,
        ...(text("service") === undefined
          ? {}
          : { service: text("service") as string }),
        ...(text("days") === undefined ? {} : { days: text("days") as string }),
        ...(text("from") === undefined ? {} : { from: text("from") as string }),
        ...(text("to") === undefined ? {} : { to: text("to") as string }),
        ...(text("grace-minutes") === undefined
          ? {}
          : { graceMinutes: text("grace-minutes") as string }),
      };
      const result = report(database, config, options);
      io.out(
        format === "json"
          ? JSON.stringify(result, null, 2)
          : formatReport(result),
      );
    }
    return 0;
  } catch (error) {
    io.error(
      error instanceof CliError
        ? error.message
        : "Command failed. Check local file access, database schema and configuration; no submitted data was printed.",
    );
    return 1;
  }
}
