// Drift detection: latest run vs rolling baseline of previous runs with the same
// app-side fingerprint (prompt, scenarios, evaluator). Model id and params may differ:
// that is exactly the change we want to surface.

export const THRESHOLDS = {
  baselineRuns: 5, // rolling window N
  successRateDrop: 0.05, // absolute drop in suite success rate
  scenarioPassRateDrop: 0.2, // absolute drop in one scenario's pass rate vs its baseline mean
  latencyIncrease: 0.25, // relative increase in mean latency per task
  costPerTaskIncrease: 0.25, // relative increase in cost per completed task
  tokensIncrease: 0.25, // relative increase in mean tokens per task
};

export type Fingerprint = {
  model_config: string; model_reported: string; provider: string; simulated: boolean;
  params: { temperature: number; max_tokens: number };
  prompt_hash: string; scenario_hash: string; evaluator_version: string; timestamp: string; repeat: number;
};
export type ScenarioLine = {
  type: "scenario"; run_id: string; scenario_id: string; attempts: number; passes: number; pass_rate: number;
  violations: string[]; tool_signatures: string[]; tool_calls: { name: string; input: unknown; ok: boolean }[];
  latency_ms: { mean: number; min: number; max: number }; tokens_mean: number; cost_usd_mean: number; error?: string;
};
export type SummaryLine = {
  type: "summary"; run_id: string; fingerprint: Fingerprint; scenarios_expected: number; scenarios_run: number;
  success_rate: number; completed_tasks: number; violations_total: number; latency_ms_mean: number;
  tokens_mean: number; cost_usd_total: number; cost_per_completed_task: number | null;
};
export type Line = ScenarioLine | SummaryLine;
export type Finding = { kind: string; scenario?: string; detail: string };
export type DriftResult = { status: "ok" | "drift" | "no_baseline" | "incomplete"; findings: Finding[]; latest?: SummaryLine; baseline: SummaryLine[]; markdown: string };

const key = (s: SummaryLine) => `${s.fingerprint.prompt_hash}|${s.fingerprint.scenario_hash}|${s.fingerprint.evaluator_version}`;
const complete = (s: SummaryLine) => s.scenarios_run > 0 && s.scenarios_run >= s.scenarios_expected;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function detectDrift(lines: Line[], t = THRESHOLDS): DriftResult {
  const summaries = lines.filter((l): l is SummaryLine => l.type === "summary");
  const latest = summaries.at(-1);
  const byRun = (id: string) => lines.filter((l): l is ScenarioLine => l.type === "scenario" && l.run_id === id);
  const done = (status: DriftResult["status"], findings: Finding[], baseline: SummaryLine[] = []) =>
    ({ status, findings, latest, baseline, markdown: render(status, findings, latest, baseline) });

  if (!latest) return done("incomplete", [{ kind: "incomplete", detail: "No run summary found in history." }]);
  const latestScen = byRun(latest.run_id);
  if (!complete(latest) || latestScen.length < latest.scenarios_expected)
    return done("incomplete", [{ kind: "incomplete", detail: `Run executed ${latestScen.length}/${latest.scenarios_expected} scenarios. An empty or partial run is not a pass.` }]);

  const baseline = summaries.filter((s) => s.run_id !== latest.run_id && key(s) === key(latest) && complete(s)).slice(-t.baselineRuns);
  if (!baseline.length) return done("no_baseline", [{ kind: "no_baseline", detail: "No previous complete run with the same prompt/scenario/evaluator fingerprint. This run becomes the first baseline point; nothing was compared." }]);

  const f: Finding[] = [];
  const baseSuccess = mean(baseline.map((b) => b.success_rate));
  if (baseSuccess - latest.success_rate > t.successRateDrop)
    f.push({ kind: "success_rate_drop", detail: `Suite success rate ${pct(latest.success_rate)} vs baseline ${pct(baseSuccess)}.` });

  const baseScen = baseline.flatMap((b) => byRun(b.run_id));
  for (const s of latestScen) {
    const prev = baseScen.filter((p) => p.scenario_id === s.scenario_id);
    if (!prev.length) { f.push({ kind: "new_scenario", scenario: s.scenario_id, detail: "Not present in baseline." }); continue; }
    const prevRate = mean(prev.map((p) => p.pass_rate));
    if (prevRate - s.pass_rate > t.scenarioPassRateDrop)
      f.push({ kind: "scenario_pass_rate_drop", scenario: s.scenario_id, detail: `pass rate ${pct(s.pass_rate)} vs baseline ${pct(prevRate)}.` });
    const seenViol = new Set(prev.flatMap((p) => p.violations));
    const newViol = s.violations.filter((v) => !seenViol.has(v));
    if (newViol.length) f.push({ kind: "new_violation", scenario: s.scenario_id, detail: newViol.join("; ") });
    const seenSig = new Set(prev.flatMap((p) => p.tool_signatures));
    const newSig = s.tool_signatures.filter((x) => !seenSig.has(x));
    if (newSig.length) f.push({ kind: "tool_call_change", scenario: s.scenario_id, detail: `baseline: \`${[...seenSig][0]}\` -> latest: \`${newSig[0]}\`` });
  }

  const rel = (now: number, base: number) => (base > 0 ? (now - base) / base : 0);
  const baseLat = mean(baseline.map((b) => b.latency_ms_mean));
  if (rel(latest.latency_ms_mean, baseLat) > t.latencyIncrease)
    f.push({ kind: "latency_increase", detail: `mean latency/task ${latest.latency_ms_mean.toFixed(0)} ms vs baseline ${baseLat.toFixed(0)} ms (+${pct(rel(latest.latency_ms_mean, baseLat))}).` });
  const baseTok = mean(baseline.map((b) => b.tokens_mean));
  if (rel(latest.tokens_mean, baseTok) > t.tokensIncrease)
    f.push({ kind: "tokens_increase", detail: `mean tokens/task ${latest.tokens_mean.toFixed(0)} vs baseline ${baseTok.toFixed(0)} (+${pct(rel(latest.tokens_mean, baseTok))}).` });
  const baseCost = mean(baseline.map((b) => b.cost_per_completed_task ?? 0));
  const cost = latest.cost_per_completed_task;
  if (cost === null) f.push({ kind: "cost_per_task_increase", detail: "No task completed, cost per completed task is undefined." });
  else if (rel(cost, baseCost) > t.costPerTaskIncrease)
    f.push({ kind: "cost_per_task_increase", detail: `cost per completed task $${cost.toFixed(6)} vs baseline $${baseCost.toFixed(6)} (+${pct(rel(cost, baseCost))}).` });

  return done(f.length ? "drift" : "ok", f, baseline);
}

function render(status: DriftResult["status"], findings: Finding[], latest: SummaryLine | undefined, baseline: SummaryLine[]) {
  const title = { ok: "OK - no change detected", drift: "CHANGE DETECTED", no_baseline: "NO BASELINE - not verified", incomplete: "INCOMPLETE RUN - not verified" }[status];
  const out = [`# Model Canary: ${title}`, ""];
  if (latest?.fingerprint.simulated) out.push("> **SIMULATION.** This run used a simulated model (`" + latest.fingerprint.model_config + "`). Regressions in sim-v2 are injected on purpose; latency and tokens are computed, not measured.", "");
  out.push("> This report signals a **behavior change** between the latest run and its baseline. It does not prove the provider caused it. Attributing cause requires investigation: compare the fingerprints below, re-run with `--repeat N` to rule out sampling noise, and check the provider's changelog.", "");
  if (latest) {
    const b = baseline.at(-1)?.fingerprint;
    const fp = latest.fingerprint;
    out.push("## Fingerprint", "", "| field | baseline (most recent) | latest |", "|---|---|---|");
    for (const k of ["model_config", "model_reported", "provider", "params", "prompt_hash", "scenario_hash", "evaluator_version", "timestamp", "repeat"] as const) {
      const v = (x: any) => (x === undefined ? "-" : typeof x === "object" ? JSON.stringify(x) : String(x));
      const changed = b && v(b[k]) !== v(fp[k]) && k !== "timestamp" ? " **(changed)**" : "";
      out.push(`| ${k} | ${v(b?.[k])} | ${v(fp[k])}${changed} |`);
    }
    out.push("", `Baseline runs compared: ${baseline.length} (${baseline.map((s) => s.run_id).join(", ") || "none"})`, "");
    out.push(`Latest: success ${pct(latest.success_rate)}, ${latest.violations_total} violations, ${latest.latency_ms_mean.toFixed(0)} ms/task, cost/completed task ${latest.cost_per_completed_task === null ? "n/a" : "$" + latest.cost_per_completed_task.toFixed(6)}`, "");
  }
  const affected = [...new Set(findings.filter((x) => x.scenario).map((x) => x.scenario!))];
  if (affected.length) out.push(`## Affected scenarios (${affected.length})`, "", ...affected.map((s) => `- \`${s}\``), "");
  out.push("## Findings", "");
  if (!findings.length) out.push("None.");
  else out.push("| kind | scenario | detail |", "|---|---|---|", ...findings.map((x) => `| ${x.kind} | ${x.scenario ?? "(suite)"} | ${x.detail.replace(/\|/g, "\\|")} |`));
  return out.join("\n") + "\n";
}
