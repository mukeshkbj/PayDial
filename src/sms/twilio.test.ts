import assert from "node:assert/strict"
import { test } from "node:test"
import { twilioSignatureValid, twilioSms } from "./twilio.ts"

const config = { accountSid: "AC123", authToken: "12345", fromNumber: "+15550001111" }

test("twilioSms posts the form body to the Messages endpoint with basic auth", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    return Response.json({ sid: "SM1" }, { status: 201 })
  }
  await twilioSms({ ...config, fetch }).send("+15552223333", "Dial is calling Sam's Bagels now.")

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json")
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.authorization, `Basic ${Buffer.from("AC123:12345").toString("base64")}`)
  assert.equal(calls[0]!.init.method, "POST")
  const form = new URLSearchParams(String(calls[0]!.init.body))
  assert.deepEqual(Object.fromEntries(form), { To: "+15552223333", From: "+15550001111", Body: "Dial is calling Sam's Bagels now." })
})

test("twilioSms throws Twilio's own error message on a failed send", async () => {
  const fetch = async () => Response.json({ message: "The 'To' number is not a valid phone number." }, { status: 400 })
  await assert.rejects(twilioSms({ ...config, fetch }).send("nope", "hi"), /not a valid phone number/)
})

const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" }
const signature = "NGAgWNhdnsLF8j385frvrQoi9sg="

test("twilioSignatureValid accepts the signature computed over the URL and sorted parameters", () => {
  assert.equal(twilioSignatureValid("12345", "https://example.com/myapp", params, signature), true)
})

test("twilioSignatureValid rejects a changed parameter, URL, token or signature", () => {
  assert.equal(twilioSignatureValid("12345", "https://example.com/myapp", { ...params, Digits: "9999" }, signature), false)
  assert.equal(twilioSignatureValid("12345", "https://example.com/other", params, signature), false)
  assert.equal(twilioSignatureValid("54321", "https://example.com/myapp", params, signature), false)
  assert.equal(twilioSignatureValid("12345", "https://example.com/myapp", params, "not-a-signature"), false)
  assert.equal(twilioSignatureValid("12345", "https://example.com/myapp", params, ""), false)
})
