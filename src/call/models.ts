export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
export type Message = { role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export type Tool = { type: "function"; function: { name: string; description?: string; parameters?: unknown } }
export type Complete = (messages: Message[], tools?: Tool[]) => Promise<Message>

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
type Turn = { role: "user" | "assistant"; content: Block[] }

export function openaiChat({ apiKey, model, baseUrl = "https://api.openai.com/v1" }: { apiKey: string; model: string; baseUrl?: string }): Complete {
  return async (messages, tools) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, ...(tools ? { tools } : {}) }),
    })
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${await response.text()}`)
    const { choices } = (await response.json()) as { choices: { message: Message }[] }
    const { content, tool_calls } = choices[0]!.message
    return { role: "assistant", content: content ?? null, ...(tool_calls?.length ? { tool_calls } : {}) }
  }
}

export function toAnthropic(messages: Message[]): { system: string; turns: Turn[] } {
  const system: string[] = []
  const turns: Turn[] = []
  const add = (role: Turn["role"], blocks: Block[]) => {
    if (!blocks.length) return
    const last = turns.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }
  for (const m of messages) {
    if (m.role === "system" && !turns.length) {
      if (m.content) system.push(m.content)
      continue
    }
    if (m.role === "system") {
      add("user", [{ type: "text", text: `[Note from Dial, not the shop] ${m.content ?? ""}` }])
      continue
    }
    if (m.role === "tool") {
      add("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" }])
      continue
    }
    if (m.role === "assistant") {
      const text: Block[] = m.content ? [{ type: "text", text: m.content }] : []
      const uses: Block[] = (m.tool_calls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") }))
      add("assistant", [...text, ...uses])
      continue
    }
    if (m.content) add("user", [{ type: "text", text: m.content }])
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: [{ type: "text", text: "(The phone rings, and you answer it.)" }] })
  return { system: system.join("\n\n"), turns }
}

export function anthropicChat({ apiKey, model, baseUrl = "https://api.anthropic.com/v1", maxTokens = 1024 }: { apiKey: string; model: string; baseUrl?: string; maxTokens?: number }): Complete {
  return async (messages, tools) => {
    const { system, turns } = toAnthropic(messages)
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: turns,
        ...(tools ? { tools: tools.map(({ function: f }) => ({ name: f.name, description: f.description ?? "", input_schema: f.parameters ?? { type: "object", properties: {} } })) } : {}),
      }),
    })
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${await response.text()}`)
    const { content } = (await response.json()) as { content: Block[] }
    const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim()
    const tool_calls: ToolCall[] = content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : []))
    return { role: "assistant", content: text || null, ...(tool_calls.length ? { tool_calls } : {}) }
  }
}
