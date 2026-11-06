import { WebSocket } from "ws"
import { twilioSignatureValid } from "../sms/twilio.ts"
import type { Brief, CallHandlers, CallSession, PlaceCall, Unreached } from "./call.ts"
import { KEYPAD, tones } from "./dtmf.ts"

const HANGUP_GRACE_MS = 10_000
const RING_SECONDS = "30"
const MAX_CALL_SECONDS = "600"
const HARMLESS = new Set(["conversation_already_has_active_response", "response_cancel_not_active"])
const UNREACHED: Record<string, Unreached> = { busy: "busy", "no-answer": "no_answer", failed: "failed" }

type Config = {
  accountSid: string
  authToken: string
  fromNumber: string
  publicUrl: string
  openaiApiKey: string
  model?: string
  voice?: string
  twilioApiBase?: string
  realtimeUrl?: string
  greetAfterMs?: number
}

type Call = {
  brief: Brief
  handlers: CallHandlers
  sid: string
  token: string
  ended: boolean
  dropped: boolean
  outbox: string[]
  responding: boolean
  wantsResponse: boolean
  heardMs: number
  playing: number
  shopSpoke: boolean
  speaking?: { itemId: string; startMs: number; sentMs: number }
  socket?: WebSocket
  stream?: { sid: string; send(message: string): void }
}

export function twilioRealtimeCalls({
  accountSid,
  authToken,
  fromNumber,
  publicUrl,
  openaiApiKey,
  model = "gpt-realtime",
  voice = "marin",
  twilioApiBase = "https://api.twilio.com",
  realtimeUrl = "wss://api.openai.com/v1/realtime",
  greetAfterMs = 4_000,
}: Config) {
  const calls = new Map<string, Call>()
  const base = publicUrl.replace(/\/$/, "")
  const streamBase = base.replace(/^http/, "ws")
  const statusUrl = (errandId: string) => `${base}/twilio/status/${errandId}`

  async function twilio(path: string, form: Record<string, string>) {
    const response = await fetch(`${twilioApiBase}/2010-04-01/Accounts/${accountSid}/${path}`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` },
      body: new URLSearchParams(form),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`Twilio ${response.status}: ${body.message ?? "request failed"} (code ${body.code ?? "none"})`)
    return body
  }

  function toOpenAI(call: Call, event: object) {
    if (call.ended) return
    const data = JSON.stringify(event)
    if (call.socket?.readyState === WebSocket.OPEN) call.socket.send(data)
    else call.outbox.push(data)
  }

  function finish(errandId: string, call: Call, detail: string, unreached?: Unreached) {
    if (call.ended) return
    call.ended = true
    calls.delete(errandId)
    call.socket?.close()
    call.handlers.onEnded(detail, unreached)
  }

  function respond(call: Call) {
    if (call.responding) {
      call.wantsResponse = true
      return
    }
    call.responding = true
    toOpenAI(call, { type: "response.create" })
  }

  function interrupted(call: Call) {
    if (call.speaking)
      toOpenAI(call, { type: "conversation.item.truncate", item_id: call.speaking.itemId, content_index: 0, audio_end_ms: Math.max(0, Math.min(call.heardMs - call.speaking.startMs, call.speaking.sentMs)) })
    call.speaking = undefined
    call.playing = 0
    call.stream?.send(JSON.stringify({ event: "clear", streamSid: call.stream.sid }))
  }

  function play(call: Call, payload: string) {
    if (!call.stream) return
    call.stream.send(JSON.stringify({ event: "media", streamSid: call.stream.sid, media: { payload } }))
    call.stream.send(JSON.stringify({ event: "mark", streamSid: call.stream.sid, mark: { name: "played" } }))
    call.playing += 1
  }

  function drop(errandId: string, call: Call) {
    if (call.dropped || call.ended) return
    call.dropped = true
    twilio(`Calls/${call.sid}.json`, { Status: "completed" }).catch((error) => finish(errandId, call, `Hangup failed: ${error.message}`))
  }

  function fail(errandId: string, call: Call, detail: string) {
    drop(errandId, call)
    finish(errandId, call, detail)
  }

  async function runTool(call: Call, { name, arguments: raw, call_id }: { name: string; arguments: string; call_id: string }) {
    let output: string
    try {
      output = await call.handlers.onToolCall(name, JSON.parse(raw))
    } catch (error) {
      output = `The tool ${name} failed: ${error instanceof Error ? error.message : error}`
    }
    toOpenAI(call, { type: "conversation.item.create", item: { type: "function_call_output", call_id, output } })
    respond(call)
  }

  function connect(errandId: string, call: Call) {
    const socket = new WebSocket(`${realtimeUrl}?model=${model}`, { headers: { Authorization: `Bearer ${openaiApiKey}` } })
    call.socket = socket
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            instructions: call.brief.instructions,
            tools: call.brief.tools.map((tool) => ({ type: "function", ...tool })),
            tool_choice: "auto",
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                transcription: { model: "gpt-4o-transcribe" },
                turn_detection: { type: "server_vad" },
              },
              output: { format: { type: "audio/pcmu" }, voice },
            },
          },
        }),
      )
      for (const data of call.outbox.splice(0)) socket.send(data)
      setTimeout(() => call.shopSpoke || call.responding || call.ended || respond(call), greetAfterMs).unref()
    })
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString())
      switch (event.type) {
        case "response.created":
          call.responding = true
          break
        case "response.done":
          call.responding = false
          if (call.wantsResponse) {
            call.wantsResponse = false
            respond(call)
          }
          break
        case "response.output_audio.delta":
          if (!call.speaking || call.speaking.itemId !== event.item_id) call.speaking = { itemId: event.item_id, startMs: call.heardMs, sentMs: 0 }
          call.speaking.sentMs += Math.floor((event.delta.length * 3) / 4 / 8)
          play(call, event.delta)
          break
        case "input_audio_buffer.speech_started":
          call.shopSpoke = true
          interrupted(call)
          break
        case "conversation.item.input_audio_transcription.completed":
          if (event.transcript.trim()) call.handlers.onLine("shop", event.transcript.trim())
          break
        case "response.output_audio_transcript.done":
          if (event.transcript.trim()) call.handlers.onLine("agent", event.transcript.trim())
          break
        case "response.function_call_arguments.done":
          void runTool(call, event)
          break
        case "error":
          if (HARMLESS.has(event.error?.code)) {
            if (event.error.code === "conversation_already_has_active_response") call.wantsResponse = true
            break
          }
          fail(errandId, call, `OpenAI error: ${event.error?.message ?? "unknown"}`)
          break
      }
    })
    socket.on("error", (error) => fail(errandId, call, `OpenAI connection error: ${error.message}`))
    socket.on("close", () => fail(errandId, call, "OpenAI connection closed"))
  }

  const placeCall: PlaceCall = async ({ errandId, input }, brief, handlers) => {
    const token = crypto.randomUUID()
    const twiml = `<Response><Connect><Stream url="${streamBase}/twilio/media/${errandId}"><Parameter name="token" value="${token}"/></Stream></Connect></Response>`
    const { sid } = await twilio("Calls.json", {
      To: input.shop.phone,
      From: fromNumber,
      Twiml: twiml,
      Timeout: RING_SECONDS,
      TimeLimit: MAX_CALL_SECONDS,
      StatusCallback: statusUrl(errandId),
      MachineDetection: "Enable",
      MachineDetectionSpeechThreshold: "6000",
      AsyncAmd: "true",
      AsyncAmdStatusCallback: statusUrl(errandId),
    })
    const call: Call = { brief, handlers, sid, token, ended: false, dropped: false, outbox: [], responding: false, wantsResponse: false, heardMs: 0, playing: 0, shopSpoke: false }
    calls.set(errandId, call)
    const session: CallSession = {
      inform(note) {
        toOpenAI(call, {
          type: "conversation.item.create",
          item: { type: "message", role: "system", content: [{ type: "input_text", text: note }] },
        })
        respond(call)
      },
      press(digits) {
        if (!KEYPAD.test(digits)) return
        play(call, tones(digits).toString("base64"))
      },
      hangup() {
        if (!call.stream) return drop(errandId, call)
        call.stream.send(JSON.stringify({ event: "mark", streamSid: call.stream.sid, mark: { name: "hangup" } }))
        setTimeout(() => drop(errandId, call), HANGUP_GRACE_MS).unref()
      },
    }
    return session
  }

  function acceptMediaStream(errandId: string, send: (message: string) => void) {
    const call = calls.get(errandId)
    if (!call) throw new Error(`No pending call for errand ${errandId}`)
    return {
      receive(message: string) {
        const event = JSON.parse(message)
        if (event.event === "start" && !call.stream && event.start?.customParameters?.token === call.token) {
          call.stream = { sid: event.start.streamSid, send }
          return connect(errandId, call)
        }
        if (!call.stream || call.stream.send !== send) return
        switch (event.event) {
          case "media":
            call.heardMs = Number(event.media.timestamp) || call.heardMs
            toOpenAI(call, { type: "input_audio_buffer.append", audio: event.media.payload })
            break
          case "mark":
            if (event.mark?.name === "hangup") drop(errandId, call)
            else if (call.playing > 0 && --call.playing === 0) call.speaking = undefined
            break
          case "stop":
            finish(errandId, call, "Call ended")
            break
        }
      },
      close: () => call.stream?.send === send && finish(errandId, call, "Media stream closed"),
    }
  }

  function acceptStatus(errandId: string, form: Record<string, string>, signature: string): boolean {
    if (!twilioSignatureValid(authToken, statusUrl(errandId), form, signature)) return false
    const call = calls.get(errandId)
    if (!call) return true
    if (/^(machine|fax)/.test(form.AnsweredBy ?? "")) {
      drop(errandId, call)
      finish(errandId, call, `Answered by ${form.AnsweredBy}`, "voicemail")
      return true
    }
    const status = form.CallStatus ?? ""
    if (UNREACHED[status]) finish(errandId, call, `Twilio reports the call ${status}`, UNREACHED[status])
    else if (status === "completed" || status === "canceled") finish(errandId, call, "Call ended")
    return true
  }

  return { placeCall, acceptMediaStream, acceptStatus }
}
