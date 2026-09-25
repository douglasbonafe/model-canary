import { describe, expect, it } from "vitest";
import { detectDrift, type Line, type ScenarioLine, type SummaryLine } from "./drift.ts";
import { evaluate, SCENARIOS } from "./canary.ts";
import { runAgent } from "./agent.ts";
import { makeModel } from "./models.ts";

function run(id: string, model: string, scen: Partial<ScenarioLine>[], over: Partial<SummaryLine> = {}): Line[] {
  const lines: ScenarioLine[] = scen.map((s, i) => ({
    type: "scenario", run_id: id, scenario_id: `s${i}`, attempts: 1, passes: 1, pass_rate: 1, violations: [],
    tool_signatures: ["lookup_customer({})"], tool_calls: [], latency_ms: { mean: 500, min: 500, max: 500 },
    tokens_mean: 1000, cost_usd_mean: 0.001, ...s,
  }));
  const passed = lines.reduce((a, l) => a + l.passes, 0);
  const summary: SummaryLine = {
    type: "summary", run_id: id,
    fingerprint: { model_config: model, model_reported: model, provider: "simulated", simulated: true, params: { temperature: 0, max_tokens: 1024 }, prompt_hash: "p", scenario_hash: "s", evaluator_version: "1", timestamp: "t", repeat: 1 },
    scenarios_expected: 2, scenarios_run: lines.length,
    success_rate: lines.length ? lines.reduce((a, l) => a + l.pass_rate, 0) / lines.length : 0,
    completed_tasks: passed, violations_total: lines.reduce((a, l) => a + l.violations.length, 0),
    latency_ms_mean: 500, tokens_mean: 1000, cost_usd_total: 0.002, cost_per_completed_task: passed ? 0.002 / passed : null, ...over,
  };
  return [...lines, summary];
}
const good = [{}, {}];

describe("detectDrift", () => {
  it("empty history is incomplete, not green", () => {
    expect(detectDrift([]).status).toBe("incomplete");
  });

  it("empty run (0 scenarios) is flagged incomplete, not green", () => {
    const r = detectDrift([...run("a", "sim-v1", good), ...run("b", "sim-v1", [])]);
    expect(r.status).toBe("incomplete");
    expect(r.markdown).toContain("INCOMPLETE");
  });

  it("partial run is incomplete", () => {
    expect(detectDrift([...run("a", "sim-v1", good), ...run("b", "sim-v1", [{}])]).status).toBe("incomplete");
  });

  it("first run has no baseline", () => {
    const r = detectDrift(run("a", "sim-v1", good));
    expect(r.status).toBe("no_baseline");
    expect(r.markdown).toContain("NO BASELINE");
  });

  it("baseline ignores runs with a different app fingerprint", () => {
    const other = run("a", "sim-v1", good).map((l) => (l.type === "summary" ? { ...l, fingerprint: { ...l.fingerprint, prompt_hash: "other" } } : l));
    expect(detectDrift([...other, ...run("b", "sim-v1", good)]).status).toBe("no_baseline");
  });

  it("identical runs are ok", () => {
    expect(detectDrift([...run("a", "sim-v1", good), ...run("b", "sim-v1", good), ...run("c", "sim-v2", good)]).status).toBe("ok");
  });

  it("flags success drop, new violation, tool-arg change, latency and cost per scenario", () => {
    const latest = run("c", "sim-v2", [{}, { passes: 0, pass_rate: 0, violations: ["escalate_refund_over_limit"], tool_signatures: ["lookup_customer({\"x\":1})"] }],
      { latency_ms_mean: 900, tokens_mean: 1500 });
    const r = detectDrift([...run("a", "sim-v1", good), ...run("b", "sim-v1", good), ...latest]);
    expect(r.status).toBe("drift");
    const kinds = r.findings.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["success_rate_drop", "scenario_pass_rate_drop", "new_violation", "tool_call_change", "latency_increase", "tokens_increase", "cost_per_task_increase"]));
    expect(r.findings.filter((f) => f.scenario).every((f) => f.scenario === "s1")).toBe(true);
    expect(r.markdown).toContain("does not prove the provider caused it");
    expect(r.markdown).toContain("SIMULATION");
  });

  it("uses only the last N baseline runs", () => {
    const old = run("old", "sim-v1", [{ latency_ms: { mean: 1, min: 1, max: 1 } }, {}], { latency_ms_mean: 10 });
    const recent = [1, 2, 3, 4, 5].flatMap((i) => run(`r${i}`, "sim-v1", good));
    const r = detectDrift([...old, ...recent, ...run("z", "sim-v1", good)]);
    expect(r.baseline.map((b) => b.run_id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(r.status).toBe("ok");
  });
});

describe("suite against simulated models", () => {
  it("sim-v1 passes every scenario", async () => {
    for (const s of SCENARIOS) {
      const e = evaluate(s, await runAgent(s.message, makeModel({ model: "sim-v1", temperature: 0, max_tokens: 1024 }, 0)));
      expect({ id: s.id, ...e }).toEqual({ id: s.id, success: true, violations: [] });
    }
  });

  it("sim-v2 breaks at least one scenario", async () => {
    let failed = 0;
    for (const s of SCENARIOS) if (!evaluate(s, await runAgent(s.message, makeModel({ model: "sim-v2", temperature: 0, max_tokens: 1024 }, 0))).success) failed++;
    expect(failed).toBeGreaterThan(0);
  });
});
