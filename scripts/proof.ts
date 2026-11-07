import { sqliteErrands } from "../src/errandStore.ts"
import { proofTable } from "../src/paypal/proof.ts"
import { restPayPal } from "../src/paypal/rest.ts"

const env = process.env
const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter((name) => !env[name])
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`)
  process.exit(1)
}

const baseUrl = env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com"
const paypal = restPayPal({ clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, baseUrl })
const dbPath = env.DIAL_DB ?? "dial.db"

console.log(`# PayPal proof, ${new Date().toISOString()}\n`)
console.log(`Every row below was read from ${baseUrl} by \`npm run proof\`, for each errand in \`${dbPath}\` with a PayPal order. The last column recomputes the receipt hash from the saved transcript and compares it with the order's \`custom_id\` on PayPal.\n`)
console.log(await proofTable(sqliteErrands(dbPath).load(), paypal))
