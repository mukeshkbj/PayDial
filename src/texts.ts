import { DatabaseSync } from "node:sqlite"
import { formatUsd, isFinished, LIMIT_CEILING_CENTS, type Errand } from "./domain/errand.ts"
import type { Errands } from "./errands.ts"
import type { Places } from "./places/places.ts"
import type { Sms } from "./sms/sms.ts"

const MAX_LENGTH = 320
const EXAMPLE = "2 Sesame bagels and 1 Drip coffee from Sam's Bagels under $10"
const ASKING = /^(?:(?:hi|hello|hey)[,!.\s]+)?(?:(?:.{0,30}?\s)?(?:can|could|would|will) (?:you|u) (?:please |pls )?(?:get|order|grab)(?: me)?|(?:can|could|may) i (?:get|have|order)|i(?:'d| would) like|i (?:want|need)|(?:please |pls )?(?:order|get)(?: me)?)\s+/i
const POLITE = /[\s,]*(?:please|thanks|thank you)?[.!?\s]*$/i
const STOP = /^(?:stop|stopall|unsubscribe|cancel|end|quit)$/i
const START = /^(?:start|unstop)$/i
const HELP = /^(?:help|info)$/i
const NAMED = /^(?:(?:hi|hello|hey)[,!.\s]+)?(?:i'?m|i am|my name is|my name's|this is|it'?s|call me)\s+/i
const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
}
const AMOUNT = `(\\d+(?:\\.\\d{1,2})?|${Object.keys(NUMBERS).join("|")})`
const UNIT = "(?:\\s*(?:dollars?|bucks|usd))"
const LEAD = "(?:under|below|up to|at most|max(?:imum)?|less than|no more than|within|budget(?: is| of)?|i (?:only )?have|i've got|i got|(?:i(?:'ll| can| could| will)? )?(?:spend|pay)(?: up to| at most)?|limit(?: is)?)"
const MONEY = new RegExp(`[\\s,;]*(?<![a-z0-9])(?:and\\s+)?(?:${LEAD}\\s*:?\\s*\\$?${AMOUNT}${UNIT}?|(?:for\\s+)?\\$${AMOUNT}${UNIT}?|(?:for\\s+)?${AMOUNT}${UNIT}|\\$?${AMOUNT}${UNIT}?\\s*(?:max(?:imum)?|tops|or less))(?![a-z0-9])`, "i")
const BARE = new RegExp(`^\\$?${AMOUNT}${UNIT}?$`, "i")
const SHOP = /^(.*?)\s*(?:\b(?:from|at)\s+|@\s*)(.+)$/i
const HANG_UP = /^(?:hang up|end(?: the)? call|cancel(?: the)? (?:call|order)|nvm|never ?mind)$/i
const WAIT = /^(?:wait|more time|hold on|one moment|one minute)$/i
const YES = /^(?:yes|y|yep|yeah|ok|okay|sure|call|go|do it)$/i
const COMMAND = /^(?:yes|y|yep|yeah|no|nope|ok|okay|sure|wait|stop|start|help|retry|cancel)$/i
const DISCLOSURE = /^(?:i'?m|i am) (?:deaf|hard of hearing|hoh)[,.!]?\s*/i
const LABELLED = /^([^:]{2,40}):\s*(.+)$/
const RETRY = /^(?:retry|try again|call again)$/i
const GREETING = /^(?:hi|hello|hey|yo|hiya)$/i
const NAME = /^[a-z][a-z'-]*$/i
const PICKED_UP = /^(?:pay(?: now)?|(?:i\s+)?(?:picked\s*(?:it\s+)?up|have it))$/i

type Part = "items" | "shop" | "limit" | "confirm"
type Draft = { items?: string; shop?: string; limit?: number; asked?: Part; confirmed?: boolean }

type Saved = { greeted?: boolean; name?: string; waiting?: string; errandId?: string; stopped?: boolean; draft?: Draft }
type Chat = Saved & { sending: Promise<void> }

export type ChatStore = {
  save(phone: string, chat: Saved): void
  load(): [string, Saved][]
}

export function sqliteChats(path: string): ChatStore & { close(): void } {
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE IF NOT EXISTS chats (phone TEXT PRIMARY KEY, chat TEXT)")
  const read = db.prepare("SELECT phone, chat FROM chats")
  const write = db.prepare("INSERT OR REPLACE INTO chats (phone, chat) VALUES (?, ?)")

  return {
    close: () => db.close(),
    save: (phone, { greeted, name, waiting, errandId, stopped, draft }) =>
      void write.run(phone, JSON.stringify({ greeted, name, waiting, errandId, stopped, draft })),
    load: () => (read.all() as { phone: string; chat: string }[]).map((row) => [row.phone, JSON.parse(row.chat)]),
  }
}

type Deps = { errands: Errands; places: Places; sms: Sms; chats: ChatStore; publicUrl: string }

export type Texts = ReturnType<typeof createTexts>

function amount(word: string | undefined): number | undefined {
  if (!word) return undefined
  return Number(word) || NUMBERS[word.toLowerCase()]
}

function words(text: string): string[] {
  return text.normalize("NFD").toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean)
}

function sameShop(asked: string, name: string): boolean {
  const [first] = words(name)
  return Boolean(first) && words(asked).some((word) => word.length >= 3 && first!.startsWith(word))
}

function numbered(items: string): string {
  return items.replace(/\b[a-z]+\b/gi, (word) => String(NUMBERS[word.toLowerCase()] ?? word))
}

function read(text: string): Draft {
  const cleaned = text.replace(DISCLOSURE, "").replace(ASKING, "").replace(POLITE, "")
  const money = MONEY.exec(cleaned)
  const rest = (money ? cleaned.slice(0, money.index) + cleaned.slice(money.index + money[0].length) : cleaned).replace(POLITE, "").trim()
  const at = SHOP.exec(rest)
  const labelled = at ? null : LABELLED.exec(rest)
  const items = at ? at[1]! : labelled ? labelled[2]! : rest
  return { items: items ? numbered(items) : undefined, shop: at?.[2] ?? labelled?.[1], limit: amount(money?.[1] ?? money?.[2] ?? money?.[3] ?? money?.[4]) }
}

function nameOf(text: string): string | undefined {
  const words = text.replace(NAMED, "").replace(POLITE, "").split(/[\s,.!]+/).filter(Boolean)
  if (!NAMED.test(text) && words.length > 2) return undefined
  const [name] = words
  if (!name || GREETING.test(name) || COMMAND.test(name) || !NAME.test(name)) return undefined
  return name
}

function isOrder(text: string): boolean {
  const { items, shop, limit } = read(text)
  const parts = [items, shop, limit].filter(Boolean).length
  return parts >= 2 || (parts > 0 && ASKING.test(text))
}

function fill(draft: Draft | undefined, text: string): Draft | undefined {
  if (isOrder(text)) return read(text)
  if (!draft?.asked) return undefined
  const reply = text.replace(POLITE, "").trim()
  if (draft.asked === "confirm") return { ...draft, confirmed: YES.test(reply) }
  if (draft.asked === "limit") return { ...draft, limit: read(reply).limit ?? amount(BARE.exec(reply)?.[1]) }
  if (draft.asked === "shop") return { ...draft, shop: reply.replace(/^(?:(?:from|at)\s+|@\s*)/i, "") }
  return { ...draft, items: numbered(reply) }
}

export function createTexts({ errands, places, sms, chats: store, publicUrl }: Deps) {
  const chats = new Map<string, Chat>(store.load().map(([phone, saved]) => [phone, { ...saved, sending: Promise.resolve() }]))

  function say(phone: string, chat: Chat, body: string): Promise<void> {
    if (chat.stopped) return chat.sending
    chat.sending = chat.sending
      .then(() => sms.send(phone, body.slice(0, MAX_LENGTH - 1)))
      .catch((error) => console.error(`Text to ${phone} failed: ${error}`))
    return chat.sending
  }

  function ask(phone: string, chat: Chat, draft: Draft, asked: Part, question: string) {
    chat.draft = { ...draft, asked }
    return say(phone, chat, question)
  }

  function follow(phone: string, chat: Chat, errand: Errand, quiet = false) {
    const sent = new Set<string>()
    const keyOf = ({ state }: Errand) => (state.kind === "asking" ? `asking:${state.question}` : state.kind === "paid" && state.pending ? "paying" : state.kind)
    if (quiet) sent.add(keyOf(errand))
    const check = (current: Errand) => {
      const key = keyOf(current)
      if (!sent.has(key)) {
        sent.add(key)
        void say(phone, chat, describe(current, publicUrl))
      }
      if (isFinished(current.state)) stop()
    }
    const stop = errands.watch(errand.id, check)
    check(errand)
  }

  async function order(phone: string, chat: Chat, name: string, text: string) {
    const declined = chat.draft?.asked === "confirm" && !isOrder(text) && !YES.test(text.replace(POLITE, "").trim())
    const draft = declined ? undefined : fill(chat.draft, text)
    chat.draft = undefined
    if (declined) return say(phone, chat, "Okay, Dial will not call. Text the order again when you are ready.")
    if (!draft) return say(phone, chat, `I could not read that. Text it like this: ${EXAMPLE}`)
    const { items, shop: shopWords, limit } = draft
    if (!items) return ask(phone, chat, draft, "items", `What would you like${shopWords ? ` from ${shopWords}` : ""}?`)
    const counted = /^(\d|an?\b|dozen\b)/i.test(items)
    if (!shopWords) return ask(phone, chat, draft, "shop", counted ? `Which shop should I order ${items} from?` : `Which shop should I call? Dial reads orders in English, like this: ${EXAMPLE}`)
    if (!limit) return ask(phone, chat, draft, "limit", counted ? `What is the most you want to spend on ${items}?` : "What is the most you want to spend?")
    if (limit * 100 > LIMIT_CEILING_CENTS) return ask(phone, chat, draft, "limit", `Dial orders up to ${formatUsd(LIMIT_CEILING_CENTS)} at a time. Reply with a lower limit.`)
    const place = (await places.search(shopWords)).find((found) => sameShop(shopWords, found.name))
    if (!place) return ask(phone, chat, draft, "shop", `I could not find a shop called "${shopWords}". Which shop should I call?`)
    const maxCents = Math.round(limit * 100)
    if (!draft.confirmed) return ask(phone, chat, draft, "confirm", `I will call ${place.name} to order ${items}, up to ${formatUsd(maxCents)}. Reply YES to call, or text the order again.`)
    const shop = { name: place.name, phone: place.phone, address: place.address }
    const errand = await errands.start({ mode: "order", shop, request: items, maxCents, customerName: name })
    chat.errandId = errand.id
    follow(phone, chat, errand)
  }

  async function retry(phone: string, chat: Chat, errand: Errand) {
    const again = await errands.start(errand.input)
    chat.errandId = again.id
    follow(phone, chat, again)
  }

  async function duringErrand(phone: string, chat: Chat, errand: Errand, text: string) {
    const { state } = errand
    const reply = text.replace(POLITE, "")
    if ((state.kind === "calling" || state.kind === "asking") && HANG_UP.test(reply)) return errands.hangUp(errand.id)
    if (state.kind === "asking" && WAIT.test(reply)) {
      if (errands.wait(errand.id)) return say(phone, chat, `Dial asked ${errand.input.shop.name} to hold longer. Reply when you are ready.`)
      return say(phone, chat, `${errand.input.shop.name} cannot hold any longer. Reply now with a number or your own words.`)
    }
    if (state.kind === "asking") return errands.answer(errand.id, state.options[Number(text) - 1] ?? text)
    if (state.kind === "awaiting_approval") return say(phone, chat, `${errand.input.shop.name} is holding while you approve ${formatUsd(state.deal.totalCents)} on PayPal: ${state.approveUrl}`)
    if (state.kind !== "authorized") {
      const said = errand.transcript.findLast((line) => line.speaker === "shop")?.text
      const heard = said ? `${errand.input.shop.name} last said: "${said.slice(0, 120)}"` : `Dial is calling ${errand.input.shop.name}.`
      return say(phone, chat, `${heard} Read the whole call: ${publicUrl}/errand/${errand.id} I will text you at the next step. Text HANG UP to end the call.`)
    }
    const received = PICKED_UP.test(reply)
    if (!received && !/^problem$/i.test(reply)) return say(phone, chat, "At the counter, reply PAY. Reply PROBLEM if the order is wrong.")
    await errands
      .confirmPickup(errand.id, received)
      .catch((error) => say(phone, chat, `PayPal could not finish that: ${error.message}`))
  }

  async function handle(phone: string, chat: Chat, text: string) {
    if (!chat.name) {
      if (isOrder(text)) {
        chat.waiting = text
        return say(phone, chat, "I have your order. What is your first name?")
      }
      const name = nameOf(text)
      if (!name) return say(phone, chat, "What is your first name?")
      chat.name = name
      const waiting = chat.waiting
      chat.waiting = undefined
      if (waiting) return order(phone, chat, name, waiting)
      return say(phone, chat, `Thanks, ${name}. To order, text what you want, the shop and your limit, like this: ${EXAMPLE}`)
    }
    const errand = chat.errandId ? errands.get(chat.errandId) : undefined
    if (errand && !isFinished(errand.state)) return duringErrand(phone, chat, errand, text)
    if (errand?.state.kind === "failed" && RETRY.test(text.replace(POLITE, ""))) return retry(phone, chat, errand)
    if (errand?.state.kind === "failed" && !chat.draft && !isOrder(text))
      return say(phone, chat, `The call to ${errand.input.shop.name} has ended. Text RETRY to call again, or text a new order.`)
    return order(phone, chat, chat.name, text)
  }

  async function receive(phone: string, chat: Chat, text: string) {
    if (STOP.test(text)) {
      const state = chat.errandId ? errands.get(chat.errandId)?.state : undefined
      if (state?.kind === "calling" || state?.kind === "asking") errands.hangUp(chat.errandId!)
      const held = state?.kind === "authorized" ? ` PayPal still holds ${formatUsd(state.deal.totalCents)}. Text START, then PAY or PROBLEM, to settle it. If you do neither, Dial pays the shop a day after the hold.` : ""
      await say(phone, chat, `You will get no more texts from Dial.${held || " Text START to come back."}`)
      chat.stopped = true
      return
    }
    if (START.test(text)) {
      chat.stopped = false
      return say(phone, chat, `Welcome back. Text an order like this: ${EXAMPLE}`)
    }
    if (chat.stopped) return
    if (HELP.test(text)) return say(phone, chat, `Dial orders from local shops by phone and pays through PayPal. Text an order like this: ${EXAMPLE}. Text STOP to stop.`)
    if (!chat.greeted) {
      chat.greeted = true
      chat.waiting = isOrder(text) ? text : undefined
      return say(phone, chat, `Hi, this is Dial. ${chat.waiting ? "I have your order." : "I order from local shops for you."} What is your first name?`)
    }
    await handle(phone, chat, text)
    await chat.sending
  }

  for (const [phone, chat] of chats) {
    const errand = chat.errandId ? errands.get(chat.errandId) : undefined
    if (errand && !isFinished(errand.state)) follow(phone, chat, errand, true)
  }

  return {
    async received(phone: string, body: string): Promise<void> {
      const chat = chats.get(phone) ?? { sending: Promise.resolve() }
      chats.set(phone, chat)
      await receive(phone, chat, body.trim())
      store.save(phone, chat)
    },
  }
}

function describe({ id, state, input }: Errand, publicUrl: string): string {
  const seconds = (until: string) => Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000))
  const shop = input.shop.name
  switch (state.kind) {
    case "calling":
      return `Dial is calling ${shop} now. Read the call as it happens: ${publicUrl}/errand/${id}`
    case "signing_up":
      return `${shop} has no PayPal, so Dial texted them a sign-up link. They are signing up on the call now.`
    case "asking": {
      const options = state.options.map((option, i) => `${i + 1}. ${option}`)
      return [state.question, ...options, `${shop} is holding. Reply within ${seconds(state.until)} seconds, with a number or your own words. Text WAIT for more time.`].join("\n")
    }
    case "awaiting_approval":
      return `${shop} agreed ${formatUsd(state.deal.totalCents)} for ${state.deal.items.map((item) => `${item.quantity} ${item.name}`).join(", ").slice(0, 80)}, ready ${state.deal.pickupTime}. You pay at the counter. If you do not pay or release the hold within a day, Dial pays the shop. Approve it on PayPal: ${state.approveUrl}`
    case "authorized":
      return `PayPal is holding ${formatUsd(state.deal.totalCents)}. Pick it up ${state.deal.pickupTime}. At the counter, reply PAY, and the shop hands over your order once PayPal shows the payment. Reply PROBLEM if the order is wrong. If you do neither within a day, Dial pays the shop.`
    case "paid":
      if (state.pending) return `PayPal is finishing the payment of ${formatUsd(state.deal.totalCents)} to ${shop}. I will text you when it is done.`
      if (state.unclaimed) return `Paid. You did not pay or release the hold within a day, so Dial paid ${shop} ${formatUsd(state.deal.totalCents)}, as agreed.`
      return `Paid. PayPal sent ${formatUsd(state.deal.totalCents)} to ${shop}.`
    case "voided":
      return `Done. PayPal released the hold on ${formatUsd(state.deal.totalCents)}. You were not charged.`
    case "pay_at_pickup":
      return `${shop} does not take PayPal. Pay ${formatUsd(state.deal.totalCents)} at pickup, ${state.deal.pickupTime}.`
    case "answered":
      return `${shop} says: ${state.findings}`
    case "failed":
      if (state.reason === "user_cancelled") return `You ended the call to ${shop}. No money moved. Text RETRY to call again.`
      return `Dial could not finish this order. ${state.detail} Text RETRY to call again.`
  }
}
