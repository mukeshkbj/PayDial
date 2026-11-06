import { AnimatePresence, motion } from "motion/react"
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import type { SmsMessage } from "../../src/sms/sms.ts"
import { api } from "./api.ts"
import { useWholeLines } from "./Captions.tsx"

function visitorPhone() {
  const saved = sessionStorage.getItem("dial:text-phone")
  if (saved) return saved
  const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`
  sessionStorage.setItem("dial:text-phone", phone)
  return phone
}
const EXAMPLES = ["2 Sesame bagels and 1 Drip coffee from Sam's Bagels under $10", "2 Concha from Rosa's Panadería under $10", "1 Cheese pie, 18 inch from Tony's Pizza under $30"]

export function TextPage() {
  const [phone] = useState(visitorPhone)
  const [thread, setThread] = useState<SmsMessage[]>([])
  const [text, setText] = useState("")
  const [error, setError] = useState<string>()
  const list = useRef<HTMLOListElement>(null)
  const composer = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = "Text Dial · Dial"
    const load = () => api.thread(phone).then(setThread, (e: Error) => setError(e.message))
    load()
    const timer = setInterval(load, 800)
    return () => clearInterval(timer)
  }, [phone])

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" })
  }, [thread.length])
  useWholeLines(list, thread.length)

  async function send(event?: FormEvent, body = text) {
    event?.preventDefault()
    if (!body.trim()) return
    setText("")
    setError(undefined)
    await api.text(phone, body.trim()).catch((e: Error) => setError(e.message))
    setThread(await api.thread(phone))
  }

  return (
    <main className="page text-page">
      <section className="text-copy">
        <p className="kicker">Text Dial</p>
        <h1>Order with a text message.</h1>
        <p className="lede-sm">
          No app to install and no voice. Text Dial what you want and your limit. Dial calls the shop, asks you any question by text, and sends a PayPal link that you approve in your browser.
        </p>
        <p className="text-try">Try one:</p>
        <ul className="text-examples">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button type="button" className="chip" onClick={() => (setText(example), composer.current?.focus())}>
                {example}
              </button>
            </li>
          ))}
        </ul>
        <ol className="text-steps" aria-label="What happens next">
          <li>Dial asks for anything it needs: your name, the shop or your limit.</li>
          <li>Dial calls the shop and texts you a link to read the call as it happens.</li>
          <li>You approve the PayPal hold. At the counter, reply PAY.</li>
        </ol>
      </section>

      <section className="handset" aria-labelledby="handset-title">
        <header className="handset-head">
          <span>
            <b id="handset-title">Dial</b>
            <small>Text messages</small>
          </span>
          <span className="tag">Simulated</span>
        </header>
        <ol className="sms" ref={list} role="log" aria-label="Messages">
          {thread.length === 0 && <li className="sms-empty">Text your order, or say hello. Dial asks for your first name first.</li>}
          <AnimatePresence initial={false}>
            {thread.map((message, index) => (
              <motion.li
                key={index}
                className="sms-bubble"
                data-from={message.direction === "in" ? "you" : "dial"}
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
              >
                <span className="sr-only">{message.direction === "in" ? "You: " : "Dial: "}</span>
                {linked(message.body)}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
        <form className="sms-compose" onSubmit={send}>
          <label className="sr-only" htmlFor="sms-text">
            Text message
          </label>
          <input id="sms-text" ref={composer} value={text} onChange={(e) => setText(e.target.value)} placeholder="Text message" autoComplete="off" enterKeyHint="send" />
          <button className="button ink" disabled={!text.trim()}>
            Send
          </button>
        </form>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}

function linked(body: string): ReactNode[] {
  return body.split(/(https?:\/\/\S+)/).map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a key={index} href={part}>
        {part.replace(/^https?:\/\//, "")}
      </a>
    ) : (
      part
    ),
  )
}
