type Text = { type: "text"; text: string }
type Item =
  | { kind?: string; type: "message"; role: "user" | "system" | "assistant"; content: ({ type: string; text?: string; refusal?: string } | Text)[] }
  | { kind?: string; type: "function_call"; callId: string; name: string; arguments: string; result?: string }
  | { kind?: string; type: "function_call_output"; callId: string; output: string }
  | { kind?: string; type: "reasoning" }

export type StudioTurn = {
  input: Item[]
  instructions?: string
  tools?: { name: string; description: string; parameters: unknown; kind?: string }[]
  toolChoice?: "auto" | "none" | "required" | { name: string }
  responseFormat?: { type: "text" } | { type: "json"; name: string; description?: string; schema: unknown }
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
type Turn = { role: "user" | "assistant"; content: Block[] }

export const LEDGER_RULE =
  "You work on Dial's money ledger. You can read errands, holds, captures, voids and call receipts, and build dashboard widgets. You cannot capture, void, refund, pay or approve anything: no tool you have moves money, and Dial gives no AI one. If asked to move money, say only the customer can, at the counter."

const parse = (json: string) => {
  try {
    return JSON.parse(json || "{}")
  } catch {
    return {}
  }
}

export function anthropicTurn(turn: StudioTurn, model: string, maxTokens = 2048) {
  const system = [LEDGER_RULE, turn.instructions ?? ""]
  const turns: Turn[] = []
  const add = (role: Turn["role"], blocks: Block[]) => {
    if (!blocks.length) return
    const last = turns.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }
  const answered = new Set(turn.input.flatMap((item) => (item.type === "function_call_output" ? [item.callId] : [])))
  for (const item of turn.input) {
    if (item.type === "reasoning") continue
    if (item.type === "function_call") {
      add("assistant", [{ type: "tool_use", id: item.callId, name: item.name, input: parse(item.arguments) }])
      if (item.result !== undefined && !answered.has(item.callId)) add("user", [{ type: "tool_result", tool_use_id: item.callId, content: item.result }])
      continue
    }
    if (item.type === "function_call_output") {
      add("user", [{ type: "tool_result", tool_use_id: item.callId, content: item.output }])
      continue
    }
    const text = item.content.map((part) => ("text" in part && part.text) || ("refusal" in part && part.refusal) || "").filter(Boolean).join("\n")
    if (!text) continue
    if (item.role === "system") system.push(text)
    else add(item.role, [{ type: "text", text }])
  }
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", content: [{ type: "text", text: "Hello." }] })
  const format = turn.responseFormat
  if (format?.type === "json") system.push(`Reply with only one JSON object, no prose, matching this JSON Schema (${format.name}): ${JSON.stringify(format.schema)}`)
  const tools = (turn.tools ?? []).filter((tool) => tool.kind !== "provided").map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters ?? { type: "object", properties: {} } }))
  const choice = turn.toolChoice
  const tool_choice =
    !tools.length || !choice || choice === "auto" ? undefined : choice === "none" ? { type: "none" } : choice === "required" ? { type: "any" } : { type: "tool", name: choice.name }
  return {
    model,
    max_tokens: maxTokens,
    system: system.filter(Boolean).join("\n\n"),
    messages: turns,
    ...(tools.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
  }
}

export function studioOutput(content: Block[], id: string) {
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim()
  const message = text ? [{ id: `msg_${id}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }] : []
  const calls = content.flatMap((block) =>
    block.type === "tool_use" ? [{ id: `fc_${block.id}`, kind: "output", type: "function_call", callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}), status: "completed" }] : [],
  )
  return [...message, ...calls]
}

export function ledgerAgent({ apiKey, model, baseUrl = "https://api.anthropic.com/v1" }: { apiKey: string; model: string; baseUrl?: string }) {
  return async (turn: StudioTurn) => {
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(anthropicTurn(turn, model)),
    })
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 300)}`)
    const body = (await response.json()) as { id: string; model: string; content: Block[]; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } }
    return { id: body.id, model: body.model, output: studioOutput(body.content, body.id), incomplete: body.stop_reason === "max_tokens", usage: body.usage }
  }
}
