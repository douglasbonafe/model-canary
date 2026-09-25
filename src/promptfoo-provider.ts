// Promptfoo `exec:` provider: the prompt is a scenario id; prints the evaluated run as JSON.
// Same agent + evaluator as the canary, so Promptfoo is just an alternate viewer/runner.
import { runAgent } from "./agent.ts";
import { makeModel } from "./models.ts";
import { SCENARIOS, evaluate } from "./canary.ts";

const s = SCENARIOS.find((x) => x.id === process.argv[2]);
if (!s) throw new Error(`unknown scenario ${process.argv[2]}`);
const cfg = { model: process.env.MODEL ?? "sim-v1", temperature: Number(process.env.TEMPERATURE ?? 0), max_tokens: 1024 };
const r = await runAgent(s.message, makeModel(cfg, 0));
console.log(JSON.stringify({ ...evaluate(s, r), tool_calls: r.tool_calls, final_text: r.final_text }));
