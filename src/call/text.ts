import type { CallHandlers, CallSession, PlaceCall } from "./call.ts"
import { openaiChat, type Complete, type Message, type Tool, type ToolCall } from "./models.ts"

const IDLE_MS = 5 * 60_000
const MAX_LLM_TURNS = 40

type TextConfig = { complete: Complete } | { openaiApiKey: string; model: string; baseUrl?: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function textCalls(config: TextConfig): {
  placeCall: PlaceCall
  shopSays(errandId: string, text: string): void
} {
  const shops = new Map<string, (text: string) => void>()
  const complete = "complete" in config ? config.complete : openaiChat({ apiKey: config.openaiApiKey, model: config.model, baseUrl: config.baseUrl })

  const placeCall: PlaceCall = async ({ errandId, input }, brief, handlers: CallHandlers): Promise<CallSession> => {
    const { name, phone } = input.shop
    const persona = phone.startsWith("llm:") ? phone.slice(4) : undefined
    if (phone !== "browser" && persona === undefined) throw new Error(`Unknown text shop "${phone}"`)

    const tools: Tool[] = brief.tools.map((tool) => ({ type: "function", function: tool }))
    const agent: Message[] = [{ role: "system", content: brief.instructions }]
    const shop: Message[] | undefined =
      persona === undefined
        ? undefined
        : [
            {
              role: "system",
              content: `You are the person answering the phone at ${name}. ${persona}\nReply in one or two short spoken sentences. Stay in character and never mention that you are an AI model.`,
            },
          ]

    let ended = false
    let turns = 0
    let idle: ReturnType<typeof setTimeout> | undefined
    let queue = Promise.resolve()
    const pending: Message[] = []

    function end(detail: string) {
      if (ended) return
      ended = true
      clearTimeout(idle)
      shops.delete(errandId)
      handlers.onEnded(detail)
    }

    function enqueue(task: () => Promise<void>) {
      queue = queue.then(() => (ended ? undefined : task())).catch((error) => end(messageOf(error)))
    }

    function overLimit() {
      if (!shop || ++turns <= MAX_LLM_TURNS) return false
      end("The conversation reached the turn limit")
      return true
    }

    async function runTool(call: ToolCall): Promise<string> {
      try {
        return await handlers.onToolCall(call.function.name, JSON.parse(call.function.arguments))
      } catch (error) {
        return `Tool error: ${messageOf(error)}`
      }
    }

    async function agentTurn() {
      const spoken: string[] = []
      agent.push(...pending.splice(0))
      if (overLimit()) return
      for (;;) {
        const reply = await complete(agent, tools)
        if (ended) return
        agent.push(reply)
        if (reply.content) {
          spoken.push(reply.content)
          handlers.onLine("agent", reply.content)
        }
        if (!reply.tool_calls) break
        for (const call of reply.tool_calls) {
          const content = await runTool(call)
          agent.push({ role: "tool", tool_call_id: call.id, content })
        }
        if (ended) return
      }
      if (!shop || !spoken.length || overLimit()) return
      shop.push({ role: "user", content: spoken.join(" ") })
      const reply = await complete(shop)
      if (ended) return
      shop.push(reply)
      if (reply.content) shopLine(reply.content)
    }

    function shopLine(text: string) {
      if (ended) return
      if (!shop) {
        clearTimeout(idle)
        idle = setTimeout(() => end("shop stopped responding"), IDLE_MS)
      }
      handlers.onLine("shop", text)
      pending.push({ role: "user", content: text })
      enqueue(agentTurn)
    }

    shops.set(errandId, shopLine)
    if (shop) {
      const greeting = `${name}, how can I help?`
      shop.push({ role: "assistant", content: greeting })
      setTimeout(() => shopLine(greeting), 0)
    } else {
      idle = setTimeout(() => end("shop stopped responding"), IDLE_MS)
    }

    return {
      inform(note) {
        if (ended) return
        pending.push({ role: "system", content: note })
        enqueue(agentTurn)
      },
      press() {},
      hangup: () => end("agent hung up"),
    }
  }

  return { placeCall, shopSays: (errandId, text) => shops.get(errandId)?.(text) }
}
