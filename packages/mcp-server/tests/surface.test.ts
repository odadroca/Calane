import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools.js";

const EXPECTED = [
  "run_pipeline",
  "get_run_result",
  "list_pipelines",
  "validate_pipeline",
  "export_run_bundle",
  "rerun_channel",
  "list_runs",
  "get_pipeline_spec",
];

describe("compact tool surface", () => {
  it("MCP exposes exactly the 8 mandatory tools", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
    expect(TOOL_DEFINITIONS.length).toBeLessThanOrEqual(30);
  });

  it("openai.json exposes the same 8 tools", () => {
    const path = fileURLToPath(new URL("../../server/public/openai.json", import.meta.url));
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const names = manifest.tools.map((t: any) => t.function.name).sort();
    expect(names).toEqual([...EXPECTED].sort());
    expect(manifest.tools.length).toBeLessThanOrEqual(30);
  });
});
