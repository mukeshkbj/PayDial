import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { WebSocket, WebSocketServer } from "ws"
import type { CallHandlers } from "./call.ts"
import { twilioRealtimeCalls } from "./twilio-realtime.ts"

const ERRAND = "errand-1"
const tools = [{ name: "end_call", description: "Hang up.", parameters: { type: "object", properties: {} } }]
const brief = { instructions: "Order bagels politely.", tools }
const target = {
  errandId: ERRAND,
  input: { mode: "order" as const, shop: { name: "Sam's Bagels", phone: "+15551230000" }, request: "bagels", maxCents: 2_000, customerName: "Maria" },
}

type Json = Record<string, any>

const tokenOf = (rest: { form: URLSearchParams }[]) => /name="token" value="([^"]+)"/.exec(rest[0]!.form.get("Twiml")!)![1]!

async function rig(t: TestContext, options: { twilioStatus?: number; onToolCall?: CallHandlers["onToolCall"]; greetAfterMs?: number } = {}) {
  const server = new WebSocketServer({ port: 0 })
  await once(server, "listening")
  const openai: { socket?: WebSocket; headers?: Json; url?: string; received: Json[] } = { received: [] }
  server.on("connection", (socket, request) => {
    openai.socket = socket
    openai.headers = request.headers
    openai.url = request.url
    socket.on("message", (data) => openai.received.push(JSON.parse(data.toString())))
  })

  const rest: { url: string; init: RequestInit; form: URLSearchParams }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    rest.push({ url, init, form: init.body as URLSearchParams })
    return options.twilioStatus
      ? new Response(JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number" }), { status: options.twilioStatus })
      : new Response(JSON.stringify({ sid: "CA123" }), { status: 201 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
    server.close()
    for (const client of server.clients) client.terminate()
  })

  const lines: [string, string][] = []
  const toolCalls: [string, unknown][] = []
  const ended: string[] = []
  const handlers: CallHandlers = {
    onLine: (speaker, text) => lines.push([speaker, text]),
    onToolCall: options.onToolCall ?? (async (name, args) => (toolCalls.push([name, args]), "Call ended.")),
    onEnded: (detail, unreached) => ended.push(unreached ? `${detail} [${unreached}]` : detail),
  }
  const twilio = twilioRealtimeCalls({
    accountSid: "AC1",
    authToken: "secret",
    fromNumber: "+15559990000",
    publicUrl: "https://dial.test/",
    openaiApiKey: "sk-test",
    twilioApiBase: "https://twilio.test",
    realtimeUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`,
    greetAfterMs: options.greetAfterMs,
  })
  const sent: Json[] = []
  const toTwilio = (message: string) => sent.push(JSON.parse(message))

  async function eventually<T>(find: () => T | undefined): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const found = find()
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error("Timed out waiting")
  }
  const openaiEvent = (type: string, nth = 0) => eventually(() => openai.received.filter((event) => event.type === type)[nth])
  const fromOpenAI = async (event: Json) => (await eventually(() => openai.socket)).send(JSON.stringify(event))

  async function connected() {
    const session = await twilio.placeCall(target, brief, handlers)
    const stream = twilio.acceptMediaStream(ERRAND, toTwilio)
    stream.receive(JSON.stringify({ event: "connected" }))
    stream.receive(JSON.stringify({ event: "start", start: { streamSid: "MZ9", callSid: "CA123", customParameters: { token: tokenOf(rest) } } }))
    await openaiEvent("session.update")
    return { session, stream }
  }

  return { twilio, rest, openai, lines, toolCalls, ended, sent, handlers, openaiEvent, fromOpenAI, eventually, connected }
}

test("placeCall asks Twilio to dial and stream media to our server", async (t) => {
  const { twilio, rest, handlers } = await rig(t)
  await twilio.placeCall(target, brief, handlers)

  assert.equal(rest.length, 1)
  assert.equal(rest[0]!.url, "https://twilio.test/2010-04-01/Accounts/AC1/Calls.json")
  assert.equal(rest[0]!.init.method, "POST")
  assert.equal((rest[0]!.init.headers as Json).authorization, `Basic ${btoa("AC1:secret")}`)
  assert.equal(rest[0]!.form.get("To"), "+15551230000")
  assert.equal(rest[0]!.form.get("From"), "+15559990000")
  assert.equal(
    rest[0]!.form.get("Twiml"),
    `<Response><Connect><Stream url="wss://dial.test/twilio/media/${ERRAND}"><Parameter name="token" value="${tokenOf(rest)}"/></Stream></Connect></Response>`,
  )
})

test("placeCall reports Twilio's error", async (t) => {
  const { twilio, handlers } = await rig(t, { twilioStatus: 400 })
  await assert.rejects(twilio.placeCall(target, brief, handlers), /Twilio 400.*Invalid 'To' Phone Number.*21211/)
})

test("acceptMediaStream rejects an unknown errand", async (t) => {
  const { twilio } = await rig(t)
  assert.throws(() => twilio.acceptMediaStream("nope", () => {}), /No pending call/)
})

test("the Realtime session is configured with the brief, tools, and mu-law audio", async (t) => {
  const { openai, connected, openaiEvent } = await rig(t)
  await connected()
  const { session } = await openaiEvent("session.update")

  assert.equal(openai.url, "/v1/realtime?model=gpt-realtime")
  assert.equal(openai.headers!.authorization, "Bearer sk-test")
  assert.equal(session.type, "realtime")
  assert.equal(session.instructions, brief.instructions)
  assert.deepEqual(session.tools, [{ type: "function", ...tools[0] }])
  assert.deepEqual(session.audio.input.format, { type: "audio/pcmu" })
  assert.deepEqual(session.audio.output.format, { type: "audio/pcmu" })
  assert.equal(session.audio.input.turn_detection.type, "server_vad")
  assert.ok(session.audio.input.transcription.model)
  assert.equal(session.audio.output.voice, "marin")
})

test("audio flows both ways, and the shop interrupting clears Twilio's buffer", async (t) => {
  const { connected, openaiEvent, fromOpenAI, sent, eventually } = await rig(t)
  const { stream } = await connected()

  stream.receive(JSON.stringify({ event: "media", streamSid: "MZ9", media: { payload: "AAEC" } }))
  assert.equal((await openaiEvent("input_audio_buffer.append")).audio, "AAEC")

  await fromOpenAI({ type: "response.output_audio.delta", delta: "QkNE" })
  assert.deepEqual(await eventually(() => sent.find((m) => m.event === "media")), { event: "media", streamSid: "MZ9", media: { payload: "QkNE" } })

  await fromOpenAI({ type: "input_audio_buffer.speech_started" })
  assert.deepEqual(await eventually(() => sent.find((m) => m.event === "clear")), { event: "clear", streamSid: "MZ9" })
})

test("audio that arrives before the Realtime socket opens is delivered after the session update", async (t) => {
  const { twilio, handlers, openai, eventually, rest } = await rig(t)
  await twilio.placeCall(target, brief, handlers)
  const stream = twilio.acceptMediaStream(ERRAND, () => {})
  stream.receive(JSON.stringify({ event: "start", start: { streamSid: "MZ9", customParameters: { token: tokenOf(rest) } } }))
  stream.receive(JSON.stringify({ event: "media", media: { payload: "AAEC" } }))
  await eventually(() => (openai.received.length >= 2 ? true : undefined))
  assert.deepEqual(openai.received.map((event) => event.type), ["session.update", "input_audio_buffer.append"])
})

test("a model function call reaches onToolCall and the result goes back to the model", async (t) => {
  const { connected, fromOpenAI, openaiEvent, openai, toolCalls } = await rig(t)
  await connected()
  await fromOpenAI({ type: "response.function_call_arguments.done", call_id: "call_7", name: "end_call", arguments: '{"reason":"done"}' })

  const output = await openaiEvent("conversation.item.create")
  assert.deepEqual(toolCalls, [["end_call", { reason: "done" }]])
  assert.deepEqual(output.item, { type: "function_call_output", call_id: "call_7", output: "Call ended." })
  await openaiEvent("response.create")
  const types = openai.received.map((event) => event.type)
  assert.ok(types.indexOf("response.create") > types.indexOf("conversation.item.create"))
})

test("a failing tool is reported to the model instead of stalling the call", async (t) => {
  const { connected, fromOpenAI, openaiEvent } = await rig(t, {
    onToolCall: async () => {
      throw new Error("bad args")
    },
  })
  await connected()
  await fromOpenAI({ type: "response.function_call_arguments.done", call_id: "call_8", name: "propose_deal", arguments: "{}" })
  const { item } = await openaiEvent("conversation.item.create")
  assert.equal(item.call_id, "call_8")
  assert.match(item.output, /propose_deal failed: bad args/)
  await openaiEvent("response.create")
})

test("inform adds a system note and asks the model to respond", async (t) => {
  const { connected, openaiEvent, openai } = await rig(t)
  const { session } = await connected()
  session.inform("Payment authorized: $12.00.")

  const { item } = await openaiEvent("conversation.item.create")
  assert.equal(item.type, "message")
  assert.equal(item.role, "system")
  assert.deepEqual(item.content, [{ type: "input_text", text: "Payment authorized: $12.00." }])
  await openaiEvent("response.create")
  const types = openai.received.map((event) => event.type)
  assert.ok(types.indexOf("response.create") > types.indexOf("conversation.item.create"))
})

test("transcripts reach onLine with the right speaker", async (t) => {
  const { connected, fromOpenAI, lines, eventually } = await rig(t)
  await connected()
  await fromOpenAI({ type: "conversation.item.input_audio_transcription.completed", transcript: " Sam's Bagels, how can I help? \n" })
  await fromOpenAI({ type: "response.output_audio_transcript.done", transcript: "Hi, this is an AI assistant." })
  await fromOpenAI({ type: "conversation.item.input_audio_transcription.completed", transcript: "  " })
  await eventually(() => (lines.length >= 2 ? true : undefined))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(lines, [
    ["shop", "Sam's Bagels, how can I help?"],
    ["agent", "Hi, this is an AI assistant."],
  ])
})

test("Twilio stop ends the call exactly once and closes the Realtime socket", async (t) => {
  const { connected, ended, openai, eventually } = await rig(t)
  const { stream } = await connected()
  stream.receive(JSON.stringify({ event: "stop", stop: { callSid: "CA123" } }))
  stream.receive(JSON.stringify({ event: "stop", stop: { callSid: "CA123" } }))
  stream.close()
  await eventually(() => (openai.socket!.readyState === WebSocket.CLOSED ? true : undefined))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(ended, ["Call ended"])
})

test("hangup lets the queued audio finish, then completes the Twilio call", async (t) => {
  const { connected, sent, rest, ended } = await rig(t)
  const { session, stream } = await connected()
  session.hangup()

  assert.deepEqual(sent.at(-1), { event: "mark", streamSid: "MZ9", mark: { name: "hangup" } })
  assert.equal(rest.length, 1)
  stream.receive(JSON.stringify({ event: "mark", streamSid: "MZ9", mark: { name: "hangup" } }))
  assert.equal(rest.length, 2)
  assert.equal(rest[1]!.url, "https://twilio.test/2010-04-01/Accounts/AC1/Calls/CA123.json")
  assert.equal(rest[1]!.form.get("Status"), "completed")
  stream.receive(JSON.stringify({ event: "stop" }))
  assert.equal(ended.length, 1)
})

test("an OpenAI error ends the call with its message and hangs up", async (t) => {
  const { connected, fromOpenAI, eventually, ended, rest } = await rig(t)
  await connected()
  await fromOpenAI({ type: "error", error: { message: "Quota exceeded" } })
  await eventually(() => (ended.length ? true : undefined))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(ended, ["OpenAI error: Quota exceeded"])
  assert.equal(rest.at(-1)!.form.get("Status"), "completed")
})

test("a media stream without the call's token is ignored and cannot end the call", async (t) => {
  const { twilio, handlers, openai, ended } = await rig(t)
  await twilio.placeCall(target, brief, handlers)
  const stranger = twilio.acceptMediaStream(ERRAND, () => {})
  stranger.receive(JSON.stringify({ event: "start", start: { streamSid: "MZ0", callSid: "CA123", customParameters: { token: "guess" } } }))
  stranger.receive(JSON.stringify({ event: "media", media: { payload: "AAAA" } }))
  stranger.receive(JSON.stringify({ event: "stop" }))
  stranger.close()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(openai.socket, undefined)
  assert.deepEqual(ended, [])
})

const STATUS_URL = `https://dial.test/twilio/status/${ERRAND}`
const sign = (form: Record<string, string>) =>
  createHmac("sha1", "secret").update(Object.keys(form).sort().reduce((text, name) => text + name + form[name], STATUS_URL)).digest("base64")

test("placeCall asks Twilio for a ring timeout, a call limit, status reports and voicemail detection", async (t) => {
  const { twilio, rest, handlers } = await rig(t)
  await twilio.placeCall(target, brief, handlers)
  const form = rest[0]!.form
  assert.equal(form.get("Timeout"), "30")
  assert.equal(form.get("TimeLimit"), "600")
  assert.equal(form.get("StatusCallback"), STATUS_URL)
  assert.equal(form.get("MachineDetection"), "Enable")
  assert.equal(form.get("AsyncAmd"), "true")
  assert.equal(form.get("AsyncAmdStatusCallback"), STATUS_URL)
})

test("a busy line, a ring with no answer, or a failed call ends the errand with the reason", async (t) => {
  for (const [status, unreached] of [["busy", "busy"], ["no-answer", "no_answer"], ["failed", "failed"]]) {
    const { twilio, handlers, ended } = await rig(t)
    await twilio.placeCall(target, brief, handlers)
    const form = { CallSid: "CA123", CallStatus: status! }
    assert.equal(twilio.acceptStatus(ERRAND, form, sign(form)), true)
    assert.equal(twilio.acceptStatus(ERRAND, form, sign(form)), true)
    assert.deepEqual(ended, [`Twilio reports the call ${status} [${unreached}]`])
  }
})

test("a status report without Twilio's signature is refused and changes nothing", async (t) => {
  const { twilio, handlers, ended } = await rig(t)
  await twilio.placeCall(target, brief, handlers)
  const form = { CallSid: "CA123", CallStatus: "busy" }
  assert.equal(twilio.acceptStatus(ERRAND, form, sign({ ...form, CallStatus: "completed" })), false)
  assert.deepEqual(ended, [])
})

test("voicemail hangs up at once and ends the errand as unreached; a person does not", async (t) => {
  const { twilio, connected, rest, ended } = await rig(t)
  await connected()
  const person = { CallSid: "CA123", AnsweredBy: "human" }
  twilio.acceptStatus(ERRAND, person, sign(person))
  assert.deepEqual(ended, [])
  const machine = { CallSid: "CA123", AnsweredBy: "machine_start" }
  twilio.acceptStatus(ERRAND, machine, sign(machine))
  assert.deepEqual(ended, ["Answered by machine_start [voicemail]"])
  assert.equal(rest.at(-1)!.form.get("Status"), "completed")
})

test("a tool result waits for the model's current response to finish before asking for the next", async (t) => {
  const { connected, fromOpenAI, openaiEvent, openai, eventually } = await rig(t)
  await connected()
  await fromOpenAI({ type: "response.created" })
  await fromOpenAI({ type: "response.function_call_arguments.done", call_id: "call_9", name: "end_call", arguments: "{}" })
  await openaiEvent("conversation.item.create")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(!openai.received.some((event) => event.type === "response.create"))
  await fromOpenAI({ type: "response.done" })
  await openaiEvent("response.create")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await eventually(() => openai.received.filter((event) => event.type === "response.create").length), 1)
})

test("an active-response error does not end the call, and the response is asked for again when the model is free", async (t) => {
  const { connected, fromOpenAI, openaiEvent, ended } = await rig(t)
  const { session } = await connected()
  session.inform("The customer answered: yes.")
  await openaiEvent("response.create")
  await fromOpenAI({ type: "error", error: { code: "conversation_already_has_active_response", message: "Conversation already has an active response" } })
  await fromOpenAI({ type: "response.done" })
  await openaiEvent("response.create", 1)
  assert.deepEqual(ended, [])
})

test("when the shop talks over the agent, the model is told how much of its reply was heard", async (t) => {
  const { connected, fromOpenAI, openaiEvent, sent, eventually } = await rig(t)
  const { stream } = await connected()
  stream.receive(JSON.stringify({ event: "media", media: { payload: "AA", timestamp: "1000" } }))
  await fromOpenAI({ type: "response.output_audio.delta", item_id: "item_1", delta: Buffer.alloc(8_000).toString("base64") })
  await eventually(() => sent.find((m) => m.event === "mark" && m.mark.name === "played"))
  stream.receive(JSON.stringify({ event: "media", media: { payload: "AA", timestamp: "1640" } }))
  await fromOpenAI({ type: "input_audio_buffer.speech_started" })
  assert.deepEqual(await openaiEvent("conversation.item.truncate"), { type: "conversation.item.truncate", item_id: "item_1", content_index: 0, audio_end_ms: 640 })
  assert.ok(sent.some((m) => m.event === "clear"))
})

test("an interruption after the agent's audio has played asks for no truncation", async (t) => {
  const { connected, fromOpenAI, openai, sent, eventually } = await rig(t)
  const { stream } = await connected()
  await fromOpenAI({ type: "response.output_audio.delta", item_id: "item_1", delta: "QkNE" })
  await eventually(() => sent.find((m) => m.event === "mark"))
  stream.receive(JSON.stringify({ event: "mark", mark: { name: "played" } }))
  await fromOpenAI({ type: "input_audio_buffer.speech_started" })
  await eventually(() => sent.find((m) => m.event === "clear"))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(!openai.received.some((event) => event.type === "conversation.item.truncate"))
})

test("press plays keypad tones into the call", async (t) => {
  const { connected, sent } = await rig(t)
  const { session } = await connected()
  session.press("1#")
  const media = sent.find((m) => m.event === "media")!
  assert.equal(Buffer.from(media.media.payload, "base64").length, 2 * 1920)
  session.press("call me")
  assert.equal(sent.filter((m) => m.event === "media").length, 1)
})

test("a truncation never claims more audio than the model sent", async (t) => {
  const { connected, fromOpenAI, openaiEvent, sent, eventually } = await rig(t)
  const { stream } = await connected()
  stream.receive(JSON.stringify({ event: "media", media: { payload: "AA", timestamp: "1000" } }))
  await fromOpenAI({ type: "response.output_audio.delta", item_id: "item_1", delta: Buffer.alloc(2_400).toString("base64") })
  await eventually(() => sent.find((m) => m.event === "mark"))
  stream.receive(JSON.stringify({ event: "media", media: { payload: "AA", timestamp: "1500" } }))
  await fromOpenAI({ type: "input_audio_buffer.speech_started" })
  assert.equal((await openaiEvent("conversation.item.truncate")).audio_end_ms, 300)
})

test("the agent speaks first when the shop answers and says nothing", async (t) => {
  const { connected, openaiEvent } = await rig(t, { greetAfterMs: 20 })
  await connected()
  assert.ok(await openaiEvent("response.create"))
})

test("the agent waits for the shop when the shop speaks first", async (t) => {
  const { connected, fromOpenAI, openai } = await rig(t, { greetAfterMs: 50 })
  await connected()
  await fromOpenAI({ type: "input_audio_buffer.speech_started" })
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(!openai.received.some((event) => event.type === "response.create"))
})

test("voicemail detection waits for a long greeting before it calls a person a machine", async (t) => {
  const { twilio, rest, handlers } = await rig(t)
  await twilio.placeCall(target, brief, handlers)
  assert.equal(rest[0]!.form.get("MachineDetectionSpeechThreshold"), "6000")
})
