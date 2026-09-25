# Model Canary

Detects **behavior changes in an LLM agent when the model/provider changes and your code does not.**
Providers ship silent updates behind stable aliases; your tests stay green because nothing in *your*
repo changed. Model Canary replays a fixed set of scenarios against the configured model on a schedule,
fingerprints every run, and compares it to a rolling baseline of earlier runs with the same prompt,
scenarios and evaluator. If behavior moves, it writes `alert.md` and fails the CI job.

It signals a **change**. It does not claim the provider caused it: attributing cause requires
investigation (the fingerprint diff narrows it down).

## What is inside

- `src/agent.ts`: a fictional SaaS support agent (Acme Cloud) with 4 tools: `lookup_customer`,
  `get_subscription`, `request_refund`, `escalate`. Tool args are validated with Zod at execution time.
- `src/models.ts`: model backends. `sim-v1` / `sim-v2` are deterministic simulations (offline, no key).
  `claude-sonnet-5` is used when `MODEL=claude-sonnet-5` and `ANTHROPIC_API_KEY` is set.
- `scenarios.json`: 26 fixed scenarios with the expected tool calls/args (ordered subsequence, args subset)
  and forbidden tools. Global rules: `lookup_first`, `valid_tool_args`, `escalate_refund_over_limit`,
  `no_false_success`.
- `src/canary.ts`: runs the suite, appends to `history/runs.jsonl`, runs drift detection, writes `alert.md`.
- `src/drift.ts`: rolling-baseline drift detection + markdown alert.
- `.github/workflows/canary.yml`: daily cron + manual dispatch, uploads history/alert as artifacts,
  commits history back, fails the job on drift or an incomplete run.
- `promptfooconfig.yaml` + `src/promptfoo-provider.ts`: optional, the same scenarios through Promptfoo.

## Run it

```bash
npm install
npm test                      # vitest: drift logic, no-baseline, empty run flagged incomplete, sim sanity
npm run demo:drift            # 3x sim-v1 (baseline) then 1x sim-v2 (simulated provider update); exits 1
npm run canary                # one run with MODEL (default sim-v1), appends history/runs.jsonl
MODEL=sim-v2 TEMPERATURE=0.7 npm run canary -- --repeat 5   # pass rate + spread per scenario
MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=... npm run canary  # real provider (costs money)
npm run eval:promptfoo        # optional, fetches promptfoo via npx
```

Env: `MODEL`, `TEMPERATURE`, `MAX_TOKENS`, `HISTORY` (default `history/runs.jsonl`), `ALERT` (default `alert.md`).
Exit code: `0` = ok or no baseline yet, `1` = drift or incomplete run.

Docker:

```bash
docker build -t model-canary .
docker run --rm -v "$PWD/history:/app/history" -e MODEL=sim-v2 model-canary --repeat 3
```

## Sample output (real, from `npm run demo:drift`)

```
[SIMULATION sim-v1] run 2026-09-25T15-28-11-745Z-06a5 repeat=1
  success 100.0%  violations 0  latency 1976 ms/task  tokens 2239/task  cost/completed $0.005705
  drift status: NO_BASELINE (1 findings, 0 baseline runs) -> alert.md
[SIMULATION sim-v1] run 2026-09-25T15-28-11-838Z-4241 repeat=1
  ...
  drift status: OK (0 findings, 1 baseline runs) -> alert.md
[SIMULATION sim-v1] run 2026-09-25T15-28-11-929Z-b279 repeat=1
  ...
  drift status: OK (0 findings, 2 baseline runs) -> alert.md
[SIMULATION sim-v2] run 2026-09-25T15-28-12-018Z-b01a repeat=1
  success 80.8%  violations 8  latency 4058 ms/task  tokens 2784/task  cost/completed $0.009100
  drift status: DRIFT (18 findings, 3 baseline runs) -> alert.md

# Model Canary: CHANGE DETECTED
> SIMULATION. This run used a simulated model (`sim-v2`). ...
> This report signals a behavior change between the latest run and its baseline. It does not prove
> the provider caused it. Attributing cause requires investigation: ...

| field | baseline (most recent) | latest |
|---|---|---|
| model_config | sim-v1 | sim-v2 (changed) |
| model_reported | sim-support-2026-01-15 | sim-support-2026-09-01 (changed) |
| prompt_hash | 13aa531617b6e13e | 13aa531617b6e13e |
| scenario_hash | 86107fcaf3faf772 | 86107fcaf3faf772 |

## Affected scenarios (5)
- refund-small-eva-cents, refund-large-carla-250, refund-boundary-100.01, refund-default-eva, refund-large-eva-149

| kind | scenario | detail |
|---|---|---|
| success_rate_drop | (suite) | Suite success rate 80.8% vs baseline 100.0%. |
| new_violation | refund-large-carla-250 | valid_tool_args: request_refund({... "amount_cents":"$250.00" ...}); escalate_refund_over_limit: refund > $100 not escalated; no_false_success: ... |
| tool_call_change | refund-boundary-100.01 | baseline: `... > request_refund(...) > escalate({"reason":"refund_over_limit"})` -> latest: `... > request_refund(...)` |
| latency_increase | (suite) | mean latency/task 4058 ms vs baseline 1976 ms (+105.3%). |
| cost_per_task_increase | (suite) | cost per completed task $0.009100 vs baseline $0.005705 (+59.5%). |

exit code: 1 (1 = drift detected)
```

`--repeat 5` with `MODEL=sim-v2 TEMPERATURE=0.7`: success 72.3%, 30 violations; e.g. `refund-small-ana`
passed 3/5 with 2 distinct tool sequences, `refund-large-carla-499` 1/5 with 4 distinct sequences.

## History format

`history/runs.jsonl`, one JSON object per line:

- `type: "scenario"`: `run_id`, `scenario_id`, `pass_rate`, `passes`, `violations`, `tool_signatures`
  (distinct tool sequences), `tool_calls` (name + args + ok), latency mean/min/max, `tokens_mean`, `cost_usd_mean`.
- `type: "summary"`: success rate, violations, latency/task, tokens/task, **cost per completed task**
  (total cost / successful attempts; `null` if nothing succeeded), scenario count, and the fingerprint.

### Fingerprint fields

| field | meaning |
|---|---|
| `model_config` | model id you asked for (`MODEL`) |
| `model_reported` | model id(s) the provider returned in the response (catches alias re-pointing) |
| `provider` | `simulated` or `anthropic` |
| `params` | temperature, max_tokens |
| `prompt_hash` | sha256 of system prompt + tool schemas |
| `scenario_hash` | sha256 of `scenarios.json` |
| `evaluator_version` | bump when grading rules change |
| `timestamp`, `repeat` | when and how many attempts per scenario |

## Drift detection

Baseline = the last N **complete** runs whose `prompt_hash`, `scenario_hash` and `evaluator_version` match
the latest run. Model and params may differ: that is the change being measured. Statuses:
`ok`, `drift`, `no_baseline` (first run, or prompt/scenarios/evaluator changed), `incomplete`
(no summary, zero scenarios, or fewer scenarios than expected: never reported green).

| threshold | default | flags |
|---|---|---|
| `baselineRuns` | 5 | rolling window size |
| `successRateDrop` | 0.05 absolute | suite success rate below baseline mean |
| `scenarioPassRateDrop` | 0.20 absolute | one scenario's pass rate below its baseline mean |
| new violation | any | a violation string never seen for that scenario in the baseline |
| tool call change | any | a tool sequence (names + args) never seen for that scenario in the baseline |
| `latencyIncrease` | +25% | mean latency per task |
| `tokensIncrease` | +25% | mean tokens per task |
| `costPerTaskIncrease` | +25% | cost per completed task (or it became `null`) |

Thresholds live in `src/drift.ts` (`THRESHOLDS`).

## What is simulated (read this)

- `sim-v1` and `sim-v2` are **rule-based stand-ins, not LLMs**. `sim-v2` is a labeled simulation of a
  provider update: it skips the >$100 refund escalation (p=0.6 per scenario), sends `amount_cents` as a
  string like `"$250.00"` (p=0.35), claims success after a failed refund, and is more verbose.
- For sim models, **latency and tokens are computed** from formulas (sim-v2: 1.5x output, 1.3x input
  tokens, 1.7x latency). **Cost** is derived from those tokens at the claude-sonnet-5 list price ($2/$10 per MTok).
- `TEMPERATURE > 0` on sims adds seeded noise per attempt; `TEMPERATURE=0` is fully deterministic.
- Every sim run and alert is labeled `SIMULATION`.

## Limitations

- Sims prove the pipeline, not that real models drift this way. Real model noise needs `--repeat N`
  and possibly wider thresholds; a single run of a real model at default sampling can flag noise.
- The rolling baseline absorbs a persistent change after N runs (by design: the alert fires on the transition).
  Pin a golden baseline if you need "never regress vs release X".
- The baseline key ignores model params, so changing `TEMPERATURE` also shows up as drift.
- Latency on the real provider includes network; one run is a small sample.
- The whole history file is read on each run (fine for years of daily runs; rotate or index if it grows).
- Real provider path is raw `fetch` without retries (the SDK is not on the allowed dependency list).

## Next steps

- Send traces to **Langfuse** (skipped in the MVP) for per-scenario trace diffs and dashboards.
- Pin golden baselines per release; statistical tests (e.g. Fisher exact) for pass-rate drops with `--repeat`.
- Slack/issue notification from the workflow.

## 3-minute video script outline

1. **0:00-0:20 Problem.** "Your agent broke and you didn't deploy anything." Silent provider updates behind aliases.
2. **0:20-0:50 Setup.** Support agent, 4 tools, 26 scenarios, rules (escalate refunds over $100, valid args).
3. **0:50-1:40 Demo.** `npm run demo:drift`: three green sim-v1 runs build the baseline, then sim-v2 (labeled SIMULATION) arrives.
4. **1:40-2:20 Read the alert.** Fingerprint table: prompt/scenario hashes unchanged, reported model changed.
   Affected scenarios, the missing `escalate` call, `"$250.00"` string arg, latency +105%, cost/task +60%.
5. **2:20-2:40 Change vs cause.** Why the alert says "change detected", not "provider broke it"; `--repeat 5` spread.
6. **2:40-3:00 Production.** GitHub Actions cron, JSONL history committed back, job fails on drift, swap `MODEL=claude-sonnet-5`.
