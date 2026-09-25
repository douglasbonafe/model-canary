// Model backends selected by config. The app (agent.ts) is identical for all of them.
//
// SIMULATION NOTICE: sim-v1 / sim-v2 are deterministic rule-based stand-ins for an LLM.
// sim-v2 is a *labeled, controlled* simulation of a silent provider update. Its
// regressions are injected on purpose so the canary has something real to catch:
//   - skips the mandatory escalation on some refunds over $100
//   - sends request_refund.amount_cents as a formatted string ("$250.00") in some cases
//   - ~1.5x output tokens (more verbose), ~1.3x input tokens (tokenizer change), ~1.7x latency
// Latency and tokens for sim models are computed, not measured.
import type { Block, ModelFn, Msg } from "./agent.ts";
import { sha } from "./agent.ts";

export type ModelConfig = { model: string; temperature: number; max_tokens: number };

// USD per 1M tokens. claude-sonnet-5 list price ($2 in / $10 out); sim models reuse it.
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "sim-v1": { in: 2, out: 10 },
  "sim-v2": { in: 2, out: 10 },
};

export function makeModel(cfg: ModelConfig, attempt: number): ModelFn {
  if (cfg.model === "sim-v1" || cfg.model === "sim-v2") return simModel(cfg, attempt);
  if (cfg.model.startsWith("claude-")) return anthropicModel(cfg);
  throw new Error(`unknown MODEL ${cfg.model} (use sim-v1, sim-v2 or claude-sonnet-5)`);
}

// Seeded PRNG (mulberry32). temperature 0 => same seed on every attempt => deterministic.
function rng(seedStr: string) {
  let a = parseInt(sha(seedStr).slice(0, 8), 16);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

function simModel(cfg: ModelConfig, attempt: number): ModelFn {
  const v2 = cfg.model === "sim-v2";
  return async ({ system, messages, tools }) => {
    const userText = messages[0].content as string;
    const rand = rng(`${cfg.model}|${userText}|${cfg.temperature > 0 ? attempt : 0}`);
    // temperature adds behavior noise: small chance to forget get_subscription
    const sloppy = cfg.temperature > 0 && rand() < cfg.temperature * 0.1;
    const skipEscalation = v2 && rand() < 0.6;
    const stringAmount = v2 && rand() < 0.35;

    const calls = history(messages);
    const called = (n: string) => calls.find((c) => c.name === n);
    const idMatch = userText.match(/C-\d{4}/);
    const amt = userText.match(/\$(\d+(?:\.\d{1,2})?)/);
    const refund = /refund|money back|charged twice|double charge/i.test(userText);
    const billing = refund || /plan|subscription|billing|invoice|renew/i.test(userText);
    const human = /manager|human|lawyer|legal|sue\b|supervisor/i.test(userText);

    let content: Block[];
    const tool = (name: string, input: unknown): Block[] => [{ type: "tool_use", id: `tu_${calls.length}`, name, input }];
    const say = (text: string): Block[] => [{ type: "text", text: v2 ? text + " Let me know if there is anything else at all I can help you with today, I'm always happy to help!" : text }];

    if (!idMatch) content = say("Could you share your customer id (like C-1234)?");
    else {
      const cid = idMatch[0];
      const sub = called("get_subscription")?.result;
      const refundCall = called("request_refund");
      if (!called("lookup_customer")) content = tool("lookup_customer", { customer_id: cid });
      else if (called("lookup_customer")!.result?.error === "not_found") content = say("I couldn't find that account.");
      else if (billing && !sub && !(sloppy && !refund)) content = tool("get_subscription", { customer_id: cid });
      else if (refund && sub?.status === "cancelled") content = say("That subscription is cancelled, so it is not eligible for a refund.");
      else if (refund && !refundCall) {
        const cents = amt ? Math.round(parseFloat(amt[1]) * 100) : sub?.monthly_cents ?? 0;
        const amount_cents = stringAmount ? `$${(cents / 100).toFixed(2)}` : cents;
        content = tool("request_refund", { customer_id: cid, amount_cents, reason: "customer request" });
      } else {
        const refundCents = amt ? Math.round(parseFloat(amt[1]) * 100) : sub?.monthly_cents ?? 0;
        const reason = human ? "customer_request" : refund && refundCents > 10000 && !skipEscalation ? "refund_over_limit" : null;
        if (reason && !called("escalate")) content = tool("escalate", { customer_id: cid, reason });
        else if (refund) content = say(refundCall?.result?.error && !v2 ? "I couldn't process the refund, a colleague will follow up." : "Your refund has been processed.");
        else if (sub) content = say(`You are on the ${sub.plan} plan (${sub.status}).`);
        else content = say(human ? "A human agent will contact you shortly." : "Your account is in good standing.");
      }
    }
    // sim-v2 also simulates a tokenizer change: same text, ~1.3x input tokens
    const input_tokens = Math.ceil(tokens({ system, messages, tools }) * (v2 ? 1.3 : 1));
    const output_tokens = Math.ceil(tokens(content) * (v2 ? 1.5 : 1)) + 20;
    const latency_ms = Math.round((250 + 6 * output_tokens + 0.05 * input_tokens + rand() * 40) * (v2 ? 1.7 : 1));
    return { model: v2 ? "sim-support-2026-09-01" : "sim-support-2026-01-15", content, usage: { input_tokens, output_tokens }, latency_ms };
  };
}

// Pair each tool_use with its tool_result so the sim can "read" the conversation.
function history(messages: Msg[]) {
  const results = new Map<string, any>();
  for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, JSON.parse(b.content));
  const calls: { name: string; input: any; result: any }[] = [];
  for (const m of messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_use") calls.push({ name: b.name, input: b.input, result: results.get(b.id) });
  return calls;
}

// Real provider, only used when MODEL=claude-* and ANTHROPIC_API_KEY is set.
// Raw fetch because the allowed dependency list excludes @anthropic-ai/sdk.
// ponytail: no retries/streaming, add @anthropic-ai/sdk if the real path becomes primary
function anthropicModel(cfg: ModelConfig): ModelFn {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("MODEL is a claude-* model but ANTHROPIC_API_KEY is not set");
  return async ({ system, messages, tools }) => {
    const t0 = performance.now();
    // Sonnet 5 rejects temperature, so it is recorded in the fingerprint but not sent.
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: cfg.max_tokens, system, messages, tools }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    // keep every block (incl. thinking) so it is echoed back unchanged; agent.ts only reads text/tool_use
    return { model: j.model, content: j.content, usage: j.usage, latency_ms: Math.round(performance.now() - t0) };
  };
}
