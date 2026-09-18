/**
 * Eval report.
 *
 *   npm run eval:report              # every scenario, summary table
 *   npm run eval:report -- --verbose # plus the full transcript of each call
 *   npm run eval:report -- <id> ...  # only the named scenarios, always verbose
 *
 * The suite is also a vitest file (`tests/evals`), which is what CI runs. This script
 * exists because a transcript you can read beats a diff you cannot.
 */

import { SCENARIOS } from "./scenarios";
import { runAll, type ScenarioResult } from "./runner";

function summarise(results: ScenarioResult[]): void {
  const width = Math.max(...results.map((r) => r.scenario.id.length));
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    const session = result.session;
    const detail = [
      `${session.metrics.turns} turns`,
      `${session.metrics.toolCalls} tools`,
      session.outcome ?? "no outcome",
    ].join(", ");
    console.log(`${status}  ${result.scenario.id.padEnd(width)}  ${detail}`);
    for (const failure of result.failures) console.log(`      - ${failure}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const toolCalls = results.reduce((sum, r) => sum + r.session.metrics.toolCalls, 0);
  const failedToolCalls = results.reduce((sum, r) => sum + r.session.metrics.failedToolCalls, 0);

  console.log("");
  console.log(`${passed}/${results.length} scenarios passed`);
  console.log(`${toolCalls} tool calls, ${failedToolCalls} of them rejected or failed`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const ids = args.filter((a) => !a.startsWith("--"));
  const selected = ids.length > 0 ? SCENARIOS.filter((s) => ids.includes(s.id)) : SCENARIOS;

  if (selected.length === 0) {
    console.error(`No scenario matched. Known ids:\n${SCENARIOS.map((s) => `  ${s.id}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }

  const results = await runAll(selected);

  if (verbose || ids.length > 0) {
    for (const result of results) {
      console.log("=".repeat(78));
      console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.scenario.id} - ${result.scenario.title}`);
      console.log(`guards: ${result.scenario.guards}`);
      console.log("-".repeat(78));
      console.log(result.transcript);
      if (result.failures.length > 0) {
        console.log("-".repeat(78));
        for (const failure of result.failures) console.log(`  FAIL ${failure}`);
      }
      console.log("");
    }
  }

  summarise(results);
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}

void main();
