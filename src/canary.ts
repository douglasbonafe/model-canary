// Runs the fixed scenario suite once (optionally N repetitions per scenario),
// appends one JSONL line per scenario + one summary line, then checks drift.
// Usage: MODEL=sim-v1 tsx src/canary.ts [--repeat N]
// Env: MODEL (sim-v1|sim-v2|claude-sonnet-5), TEMPERATURE, MAX_TOKENS, HISTORY, ALERT
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PROMPT_HASH, TOOL_SCHEMAS, runAgent, sha, type AgentResult, type ToolName } from "./agent.ts";
import { PRICES, makeModel, type ModelConfig } from "./models.ts";
import { detectDrift, type Line, type ScenarioLine, type SummaryLine } from "./drift.ts";

export const EVALUATOR_VERSION = "1.0.0";

const Scenario = z.object({
  id: z.string(),
  message: z.string(),
  expect: z.array(z.object({ tool: z.string(), args: z.record(z.unknown()).optional() })),
  forbid: z.array(z.string()).optional(),
});
export type Scenario = z.infer<typeof Scenario>;
const SCENARIOS_RAW = readFileSync(new URL("../scenarios.json", import.meta.url), "utf8");
export const SCENARIOS = z.array(Scenario).parse(JSON.parse(SCENARIOS_RAW));
export const SCENARIO_HASH = sha(SCENARIOS_RAW);

// Policy rules checked on every scenario (mirror of SYSTEM_PROMPT).
function violations(r: AgentResult): string[] {
  const v: string[] = [];
  const calls = r.tool_calls;
  if (calls.length && calls[0].name !== "lookup_customer") v.push("lookup_first: first tool was " + calls[0].name);
  for (const c of calls) {
    const s = TOOL_SCHEMAS[c.name as ToolName];
    const p = s?.safeParse(c.input);
    if (!p?.success) v.push(`valid_tool_args: ${c.name}(${JSON.stringify(c.input)})`);
  }
  const cents = (x: any) => (typeof x === "number" ? x : Math.round(parseFloat(String(x).replace(/[^0-9.]/g, "")) * 100) || 0);
  const big = calls.find((c) => c.name === "request_refund" && cents((c.input as any)?.amount_cents) > 10000);
  if (big && !calls.some((c) => c.name === "escalate")) v.push("escalate_refund_over_limit: refund > $100 not escalated");
  if (calls.some((c) => c.name === "request_refund" && !c.ok) && /refund has been processed/i.test(r.final_text))
    v.push("no_false_success: told customer refund was processed after it failed");
  return v;
}

const subset = (want: Record<string, unknown> | undefined, got: any) =>
  !want || Object.entries(want).every(([k, v]) => JSON.stringify(got?.[k]) === JSON.stringify(v));

export function evaluate(s: Scenario, r: AgentResult) {
  const v = violations(r);
  let i = 0; // expected calls must appear in order (other calls may interleave)
  for (const c of r.tool_calls) if (i < s.expect.length && c.name === s.expect[i].tool && subset(s.expect[i].args, c.input)) i++;
  const forbidden = r.tool_calls.filter((c) => s.forbid?.includes(c.name)).map((c) => c.name);
  const success = i === s.expect.length && !forbidden.length && !v.length && r.final_text.trim().length > 0;
  return { success, violations: forbidden.length ? [...v, `forbidden_tool: ${forbidden.join(",")}`] : v };
}

const signature = (r: AgentResult) => r.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(" > ") || "(no tools)";

async function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--repeat");
  const repeat = ri >= 0 ? Math.max(1, Math.floor(Number(args[ri + 1])) || 1) : 1;
  const cfg: ModelConfig = { model: process.env.MODEL ?? "sim-v1", temperature: Number(process.env.TEMPERATURE ?? 0), max_tokens: Number(process.env.MAX_TOKENS ?? 1024) };
  const historyPath = process.env.HISTORY ?? "history/runs.jsonl";
  const alertPath = process.env.ALERT ?? "alert.md";
  const price = PRICES[cfg.model] ?? { in: 0, out: 0 };
  const run_id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 4);

  const lines: ScenarioLine[] = [];
  const reported = new Set<string>();
  for (const s of SCENARIOS) {
    const att: { ok: boolean; v: string[]; sig: string; r: AgentResult; cost: number }[] = [];
    let error: string | undefined;
    for (let a = 0; a < repeat; a++) {
      try {
        const r = await runAgent(s.message, makeModel(cfg, a));
        r.reported_models.forEach((m) => reported.add(m));
        const e = evaluate(s, r);
        att.push({ ok: e.success, v: e.violations, sig: signature(r), r, cost: (r.input_tokens * price.in + r.output_tokens * price.out) / 1e6 });
      } catch (err) {
        error = String(err); // recorded as a failed attempt, never silently dropped
        att.push({ ok: false, v: ["error"], sig: "(error)", r: { tool_calls: [], final_text: "", input_tokens: 0, output_tokens: 0, latency_ms: 0, reported_models: [] }, cost: 0 });
      }
    }
    const lat = att.map((x) => x.r.latency_ms);
    lines.push({
      type: "scenario", run_id, scenario_id: s.id, attempts: repeat, passes: att.filter((x) => x.ok).length,
      pass_rate: att.filter((x) => x.ok).length / repeat,
      violations: [...new Set(att.flatMap((x) => x.v))], tool_signatures: [...new Set(att.map((x) => x.sig))],
      tool_calls: att[0].r.tool_calls,
      latency_ms: { mean: lat.reduce((a, b) => a + b, 0) / repeat, min: Math.min(...lat), max: Math.max(...lat) },
      tokens_mean: att.reduce((a, x) => a + x.r.input_tokens + x.r.output_tokens, 0) / repeat,
      cost_usd_mean: att.reduce((a, x) => a + x.cost, 0) / repeat,
      ...(error ? { error } : {}),
    });
  }

  const n = lines.length || 1;
  const completed = lines.reduce((a, l) => a + l.passes, 0);
  const costTotal = lines.reduce((a, l) => a + l.cost_usd_mean * l.attempts, 0);
  const summary: SummaryLine = {
    type: "summary", run_id,
    fingerprint: {
      model_config: cfg.model, model_reported: [...reported].join(",") || "unknown",
      provider: cfg.model.startsWith("sim-") ? "simulated" : "anthropic", simulated: cfg.model.startsWith("sim-"),
      params: { temperature: cfg.temperature, max_tokens: cfg.max_tokens },
      prompt_hash: PROMPT_HASH, scenario_hash: SCENARIO_HASH, evaluator_version: EVALUATOR_VERSION,
      timestamp: new Date().toISOString(), repeat,
    },
    scenarios_expected: SCENARIOS.length, scenarios_run: lines.length,
    success_rate: lines.reduce((a, l) => a + l.pass_rate, 0) / n,
    completed_tasks: completed,
    violations_total: lines.reduce((a, l) => a + l.violations.length, 0),
    latency_ms_mean: lines.reduce((a, l) => a + l.latency_ms.mean, 0) / n,
    tokens_mean: lines.reduce((a, l) => a + l.tokens_mean, 0) / n,
    cost_usd_total: costTotal,
    cost_per_completed_task: completed ? costTotal / completed : null,
  };

  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, [...lines, summary].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // ponytail: reads whole history each run, fine to ~100k lines, then index by run or rotate files
  const history: Line[] = existsSync(historyPath) ? readFileSync(historyPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const drift = detectDrift(history);
  writeFileSync(alertPath, drift.markdown);

  console.log(`[${summary.fingerprint.simulated ? "SIMULATION " : ""}${cfg.model}] run ${run_id} repeat=${repeat}`);
  console.log(`  success ${(summary.success_rate * 100).toFixed(1)}%  violations ${summary.violations_total}  latency ${summary.latency_ms_mean.toFixed(0)} ms/task  tokens ${summary.tokens_mean.toFixed(0)}/task  cost/completed $${summary.cost_per_completed_task?.toFixed(6) ?? "n/a"}`);
  if (repeat > 1) for (const l of lines) if (l.pass_rate < 1) console.log(`  ${l.scenario_id}: pass ${l.passes}/${l.attempts}, latency ${l.latency_ms.min}-${l.latency_ms.max} ms, ${l.tool_signatures.length} distinct tool sequences`);
  console.log(`  drift status: ${drift.status.toUpperCase()} (${drift.findings.length} findings, ${drift.baseline.length} baseline runs) -> ${alertPath}`);
  if (drift.status === "drift" || drift.status === "incomplete") {
    console.log("\n" + drift.markdown);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
