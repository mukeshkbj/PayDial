import { useEffect, useState, type FormEvent } from "react"
import { api, useErrand } from "./api.ts"
import { Captions } from "./Captions.tsx"

export function ShopLinePage({ id }: { id: string }) {
  const errand = useErrand(id)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (errand) document.title = `Shop line: ${errand.input.shop.name} · Dial`
  }, [errand?.input.shop.name])

  if (!errand) return <main className="page"><p className="notice" aria-busy="true">Connecting to the call</p></main>

  const { input, state, transcript } = errand
  const ended = state.kind === "failed" || transcript.some((line) => line.speaker === "system" && line.text.startsWith("Call ended"))
  const scripted = input.shop.phone !== "browser"

  async function send(event: FormEvent) {
    event.preventDefault()
    const said = text.trim()
    if (!said) return
    setSending(true)
    setError(undefined)
    try {
      await api.shopSays(id, said)
      setText("")
    } catch (e) {
      setError((e as Error).message)
    }
    setSending(false)
  }

  return (
    <main className="page shop-line">
      <header className="line-head">
        <p className="kicker">You are answering the phone at</p>
        <h1>{input.shop.name}</h1>
        <p className="request">
          An AI agent is calling for {input.customerName}. Answer the way the shop would. Quote a price, give a pickup time, and
          give a PayPal email such as <code>orders@{input.shop.name.toLowerCase().replace(/[^a-z]+/g, "")}.example</code>.
        </p>
      </header>

      <Captions lines={transcript} names={{ agent: "Caller", shop: "You", system: "" }} startedAt={errand.createdAt} over={state.kind === "failed"} />

      {scripted ? (
        <p className="notice">A script plays this shop. To answer yourself, start a new call and choose "You, in a new tab".</p>
      ) : (
        <form className="answer say" onSubmit={send}>
          <label className="field grow">
            <span>Say to the caller</span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={ended || sending}
              autoFocus
              placeholder={ended ? "The call has ended." : "Sure, that's $7.45. Ready in 20 minutes."}
            />
          </label>
          <button className="button ink" disabled={ended || sending || !text.trim()}>
            Say it
          </button>
        </form>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}
