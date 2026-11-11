import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk"

export const READ_ONLY = { orders: { get: true }, disputes: { list: true, get: true }, transactions: { list: true } }
export const READ_TOOLS = ["get_order", "list_disputes", "get_dispute", "list_transactions"] as const

export type JsonSchema = { type?: string; description?: string; enum?: string[]; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[] }
export type PayPalTool = { name: string; description: string; parameters: JsonSchema; run(args: unknown): Promise<unknown> }

type ZodLike = { _def: { typeName: string; description?: string; innerType?: ZodLike; values?: string[]; type?: ZodLike; shape?: () => Record<string, ZodLike> }; parse(value: unknown): unknown }
type KitTool = { description?: string; parameters: ZodLike; execute(args: unknown, options: unknown): Promise<unknown> }

export function jsonOf(schema: ZodLike): JsonSchema {
  const { typeName, description, innerType, values, type, shape } = schema._def
  const described = <T extends JsonSchema>(out: T): T => (description ? { ...out, description: out.description ?? description } : out)
  if ((typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable") && innerType) return described(jsonOf(innerType))
  if (typeName === "ZodEnum") return described({ type: "string", enum: values ?? [] })
  if (typeName === "ZodArray" && type) return described({ type: "array", items: jsonOf(type) })
  if (typeName === "ZodObject" && shape) {
    const fields = Object.entries(shape())
    return described({
      type: "object",
      properties: Object.fromEntries(fields.map(([key, value]) => [key, jsonOf(value)])),
      required: fields.filter(([, value]) => !["ZodOptional", "ZodDefault"].includes(value._def.typeName)).map(([key]) => key),
    })
  }
  return described({ type: typeName === "ZodNumber" ? "number" : typeName === "ZodBoolean" ? "boolean" : "string" })
}

export function readOnlyTools(tools: Record<string, KitTool>): PayPalTool[] {
  const names = Object.keys(tools)
  const extra = names.filter((name) => !(READ_TOOLS as readonly string[]).includes(name))
  if (extra.length) throw new Error(`PayPal's toolkit offered tools that are not read-only: ${extra.join(", ")}`)
  return names.map((name) => {
    const tool = tools[name]!
    return {
      name,
      description: (tool.description ?? "").trim().replace(/\s+/g, " "),
      parameters: jsonOf(tool.parameters),
      run: (args) => tool.execute(tool.parameters.parse(args ?? {}), { toolCallId: name, messages: [] }),
    }
  })
}

export function payPalReadTools({ clientId, clientSecret, sandbox }: { clientId: string; clientSecret: string; sandbox: boolean }): PayPalTool[] {
  const kit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: READ_ONLY, context: { sandbox } } })
  return readOnlyTools(kit.getTools() as unknown as Record<string, KitTool>)
}
