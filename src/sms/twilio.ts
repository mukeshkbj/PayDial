import { createHmac, timingSafeEqual } from "node:crypto"
import type { Sms } from "./sms.ts"

type Config = { accountSid: string; authToken: string; fromNumber: string; fetch?: typeof fetch }

export function twilioSms({ accountSid, authToken, fromNumber, fetch: send = fetch }: Config): Sms {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
  return {
    async send(to, body) {
      const res = await send(url, {
        method: "POST",
        headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: fromNumber, Body: body }),
      })
      if (res.ok) return
      const failure = (await res.json().catch(() => ({}))) as { message?: string }
      throw new Error(failure.message ?? `Twilio returned ${res.status}`)
    },
  }
}

export function twilioSignatureValid(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const signed = Object.keys(params).sort().reduce((text, name) => text + name + params[name], url)
  const expected = createHmac("sha1", authToken).update(signed).digest()
  const given = Buffer.from(signature, "base64")
  return given.length === expected.length && timingSafeEqual(given, expected)
}
