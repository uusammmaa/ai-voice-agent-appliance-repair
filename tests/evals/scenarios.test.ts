import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/evals/scenarios";
import { runScenario } from "@/evals/runner";

/**
 * The eval suite as a test. Each scenario is its own test case so a failure names the
 * caller journey that broke, and prints the transcript that broke it.
 */
describe("call scenarios", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const result = await runScenario(scenario);
      if (!result.passed) {
        throw new Error(
          [
            `${scenario.id} failed (${scenario.guards})`,
            ...result.failures.map((f) => `  - ${f}`),
            "",
            result.transcript,
          ].join("\n"),
        );
      }
      expect(result.passed).toBe(true);
    });
  }

  it("is reproducible: the same scenario twice produces the same transcript", async () => {
    const scenario = SCENARIOS[0]!;
    const a = await runScenario(scenario);
    const b = await runScenario(scenario);
    expect(b.transcript).toBe(a.transcript);
  });
});
