import type { AgAiEvent, AgAiTool, AgLlmAdapter, AgLlmResponse } from "ag-studio"
import { canonicalReceipt } from "../../src/domain/errand.ts"
import type { ReceiptView } from "../../src/receipt.ts"
import { sha256 } from "./ReceiptPage.tsx"

type Output = AgLlmResponse["output"]

function eventsOf(output: Output): AgAiEvent[] {
  return output.flatMap((item): AgAiEvent[] => {
    if (item.type === "message") {
      const text = item.content.map((part) => (part.type === "text" ? part.text : part.refusal)).join("")
      return [
        { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text },
        { type: "TEXT_MESSAGE_END", messageId: item.id },
      ]
    }
    if (item.type === "function_call")
      return [
        { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name },
        { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments },
        { type: "TOOL_CALL_END", toolCallId: item.callId },
      ]
    return []
  })
}

export function ledgerAdapter(path: string): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const complete: Promise<AgLlmResponse> = fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: options?.signal,
      }).then(async (res) => {
        const body = await res.json()
        if (!res.ok) return { id: crypto.randomUUID(), createdAt: Date.now(), status: "failed", output: [], error: { code: String(res.status), message: body.error ?? "The ledger agent failed." } }
        return {
          id: body.id,
          createdAt: Date.now(),
          status: body.incomplete ? "incomplete" : "completed",
          output: body.output,
          model: body.model,
          ...(body.incomplete ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
          ...(body.usage ? { usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } } : {}),
        } as AgLlmResponse
      })
      return {
        complete,
        stream: {
          async *[Symbol.asyncIterator]() {
            const response = await complete
            if (response.error) throw new Error(response.error.message)
            yield* eventsOf(response.output)
          },
        },
      }
    },
  }
}

export const verifyReceipt: AgAiTool = {
  name: "verify_receipt",
  description:
    "Check one errand's call receipt. Fetches the transcript, hashes it in this browser, and compares the hash with Dial's copy and with the custom_id stored on the PayPal order. Read-only: it never moves money.",
  kind: "client",
  schema: () => ({
    name: "verify_receipt",
    description: "Verify an errand's call receipt against the hash on its PayPal order.",
    parameters: { type: "object", properties: { errand: { type: "string", description: "The errand id from the ledger's errand field." } }, required: ["errand"] },
  }),
  async execute(call, ctx) {
    const id = String(call.args.errand ?? "")
    const res = await fetch(`/api/errands/${encodeURIComponent(id)}/receipt`, { signal: ctx.signal })
    if (!res.ok) return ctx.error(`Errand ${id} has no call receipt.`)
    const view = (await res.json()) as ReceiptView
    const local = await sha256(canonicalReceipt(view.shop, view.deal, view.lines))
    const matchesDial = local === view.hash
    const matchesPayPal = view.orderId ? (view.payPalError ? null : local === view.payPalCustomId) : null
    const verdict = !matchesDial || matchesPayPal === false ? "does not match" : "unchanged since the deal"
    const payPal = !view.orderId
      ? "No PayPal order holds a copy, because the customer pays in store."
      : view.payPalError
        ? `PayPal's copy on order ${view.orderId} could not be read (${view.payPalError}), so only Dial's copy was compared.`
        : `PayPal order ${view.orderId} holds custom_id ${view.payPalCustomId?.slice(0, 12) ?? "none"}…, which ${matchesPayPal ? "matches" : "does not match"}.`
    return ctx.success(
      `Receipt for ${view.shop.name}: ${verdict}. Local hash ${local.slice(0, 12)}…, Dial's ${view.hash.slice(0, 12)}…. ${payPal} Outcome: ${view.outcome}. ${view.lines.length} transcript lines covered.`,
      { local, dial: view.hash, payPal: view.payPalCustomId, orderId: view.orderId, matchesDial, matchesPayPal },
    )
  },
}
