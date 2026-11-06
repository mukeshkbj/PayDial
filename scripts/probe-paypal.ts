import { finishProbe, startProbe } from "../src/paypal/probe.ts"
import { restPayPal } from "../src/paypal/rest.ts"

const env = process.env
const usage = "usage: node scripts/probe-paypal.ts start <payeeEmail> | finish <orderId> capture|void"

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter((name) => !env[name])
if (missing.length) fail(`Missing environment variables: ${missing.join(", ")}`)

const [command, first, second] = process.argv.slice(2)
const startArgs = command === "start" && first
const finishArgs = command === "finish" && first && (second === "capture" || second === "void")
if (!startArgs && !finishArgs) fail(usage)

const baseUrl = env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com"
if (!new URL(baseUrl).hostname.includes("sandbox")) fail("The probe runs only against the PayPal sandbox. Unset PAYPAL_API_BASE or point it at the sandbox.")

const paypal = restPayPal({ clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, baseUrl, webhookId: env.PAYPAL_WEBHOOK_ID })

try {
  if (command === "start") await startProbe(paypal, first!, console.log)
  else await finishProbe(paypal, first!, second as "capture" | "void", console.log)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
