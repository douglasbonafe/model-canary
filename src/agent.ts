// The application under test: a tiny SaaS support agent.
// This file never changes between canary runs; only the MODEL config does.
import { createHash } from "node:crypto";
import { z } from "zod";

export const SYSTEM_PROMPT = `You are the support agent for Acme Cloud.
Policy:
1. Always call lookup_customer first with the customer's id (format C-1234). If no id is given, ask for it and call no tools.
2. If the customer is not found, stop and say so.
3. For billing, plan or refund questions call get_subscription.
4. Refunds: call request_refund with amount_cents as an INTEGER number of cents. If no amount is stated, refund one monthly price.
5. Never refund a cancelled subscription.
6. Any refund over $100 (10000 cents) must ALSO be escalated with escalate(reason="refund_over_limit").
7. If the customer asks for a manager/human or threatens legal action, call escalate(reason="customer_request").
8. Finish with a short plain-text reply to the customer.`;

// --- fake backend -----------------------------------------------------------
const CUSTOMERS: Record<string, { name: string; plan: string; monthly_cents: number; status: "active" | "cancelled" }> = {
  "C-1001": { name: "Ana", plan: "pro", monthly_cents: 4900, status: "active" },
  "C-1002": { name: "Bruno", plan: "basic", monthly_cents: 1900, status: "active" },
  "C-1003": { name: "Carla", plan: "enterprise", monthly_cents: 49900, status: "active" },
  "C-1004": { name: "Diego", plan: "pro", monthly_cents: 4900, status: "cancelled" },
  "C-1005": { name: "Eva", plan: "team", monthly_cents: 14900, status: "active" },
};

const CustomerId = z.string().regex(/^C-\d{4}$/);
export const TOOL_SCHEMAS = {
  lookup_customer: z.object({ customer_id: CustomerId }).strict(),
  get_subscription: z.object({ customer_id: CustomerId }).strict(),
  request_refund: z.object({ customer_id: CustomerId, amount_cents: z.number().int().positive(), reason: z.string().min(1) }).strict(),
  escalate: z.object({ customer_id: CustomerId, reason: z.enum(["refund_over_limit", "customer_request"]) }).strict(),
};
export type ToolName = keyof typeof TOOL_SCHEMAS;

// JSON Schema sent to the model (hand-written; zod above is the enforcing copy).
// ponytail: duplicated schema, add zod-to-json-schema if tools grow past a handful
const id = { type: "string", pattern: "^C-\\d{4}$" };
export const TOOLS = [
  { name: "lookup_customer", description: "Find a customer by id.", input_schema: { type: "object", properties: { customer_id: id }, required: ["customer_id"], additionalProperties: false } },
  { name: "get_subscription", description: "Get the customer's subscription.", input_schema: { type: "object", properties: { customer_id: id }, required: ["customer_id"], additionalProperties: false } },
  { name: "request_refund", description: "Issue a refund. amount_cents is an integer.", input_schema: { type: "object", properties: { customer_id: id, amount_cents: { type: "integer" }, reason: { type: "string" } }, required: ["customer_id", "amount_cents", "reason"], additionalProperties: false } },
  { name: "escalate", description: "Hand off to a human agent.", input_schema: { type: "object", properties: { customer_id: id, reason: { type: "string", enum: ["refund_over_limit", "customer_request"] } }, required: ["customer_id", "reason"], additionalProperties: false } },
];

export const PROMPT_HASH = sha(SYSTEM_PROMPT + JSON.stringify(TOOLS));

function execTool(name: string, input: unknown): { ok: boolean; result: unknown } {
  const schema = TOOL_SCHEMAS[name as ToolName];
  if (!schema) return { ok: false, result: { error: `unknown tool ${name}` } };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, result: { error: "invalid_arguments", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
  const c = CUSTOMERS[(parsed.data as { customer_id: string }).customer_id];
  if (!c) return { ok: true, result: { error: "not_found" } };
  if (name === "lookup_customer") return { ok: true, result: { name: c.name } };
  if (name === "get_subscription") return { ok: true, result: { plan: c.plan, monthly_cents: c.monthly_cents, status: c.status } };
  if (name === "request_refund") return c.status === "cancelled" ? { ok: false, result: { error: "subscription_cancelled" } } : { ok: true, result: { refund_id: "R-" + sha(JSON.stringify(input)).slice(0, 6) } };
  return { ok: true, result: { ticket: "T-" + sha(JSON.stringify(input)).slice(0, 6) } };
}

// --- model interface (Anthropic Messages shape, so sim and real share the loop)
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: any };
export type Msg = { role: "user" | "assistant"; content: string | any[] };
export type ModelReply = { model: string; content: Block[]; usage: { input_tokens: number; output_tokens: number }; latency_ms: number };
export type ModelFn = (req: { system: string; messages: Msg[]; tools: typeof TOOLS }) => Promise<ModelReply>;

export type ToolCall = { name: string; input: unknown; ok: boolean };
export type AgentResult = { tool_calls: ToolCall[]; final_text: string; input_tokens: number; output_tokens: number; latency_ms: number; reported_models: string[] };

export async function runAgent(message: string, model: ModelFn, maxTurns = 8): Promise<AgentResult> {
  const messages: Msg[] = [{ role: "user", content: message }];
  const out: AgentResult = { tool_calls: [], final_text: "", input_tokens: 0, output_tokens: 0, latency_ms: 0, reported_models: [] };
  for (let turn = 0; turn < maxTurns; turn++) {
    const r = await model({ system: SYSTEM_PROMPT, messages, tools: TOOLS });
    out.input_tokens += r.usage.input_tokens;
    out.output_tokens += r.usage.output_tokens;
    out.latency_ms += r.latency_ms;
    if (!out.reported_models.includes(r.model)) out.reported_models.push(r.model);
    messages.push({ role: "assistant", content: r.content });
    const uses = r.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    const text = r.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
    if (!uses.length) { out.final_text = text; return out; }
    const results = uses.map((u) => {
      const res = execTool(u.name, u.input);
      out.tool_calls.push({ name: u.name, input: u.input, ok: res.ok });
      return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(res.result), is_error: !res.ok };
    });
    messages.push({ role: "user", content: results });
  }
  return out; // ran out of turns: empty final_text => task fails
}

export function sha(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
