import { z } from "zod"
import { briefFor, type CallSession, type PlaceCall, type Unreached } from "./call/call.ts"
import { KEYPAD } from "./call/dtmf.ts"
import type { Cards } from "./cards.ts"
import { dealProblem, formatUsd, isFinished, LIMIT_CEILING_CENTS, MAX_WAITS, sameEmail, type Deal, type Errand, type ErrandInput, type ErrandState, type Speaker } from "./domain/errand.ts"
import type { ErrandStore } from "./errandStore.ts"
import { PayPalError, type PayPal, type PayPalOrder } from "./paypal/rest.ts"
import { receiptHash, type ReceiptView } from "./receipt.ts"
import type { Sms } from "./sms/sms.ts"

const ANSWER_TIMEOUT_MS = 90_000
const APPROVAL_TIMEOUT_MS = 180_000
const COLLECT_AFTER_MS = 24 * 60 * 60_000
const COLLECT_RETRY_MS = 60 * 60_000
const COLLECT_TRIES = 24
const PENDING_CHECK_MS = 60 * 60_000
const SIGNUP_TIMEOUT_MS = 300_000
const SIGNUP_CHECK_MS = 5_000
const GOODBYE_MS = 8_000

const askUserArgs = z.object({ question: z.string().min(1), options: z.array(z.string()).optional() })
const proposeDealArgs = z.object({
  items: z.array(z.object({ name: z.string(), quantity: z.number() })),
  total_cents: z.number(),
  pickup_time: z.string(),
  payee_email: z.string().nullable(),
})
const reportFindingsArgs = z.object({ summary: z.string().min(1) })
const pressKeysArgs = z.object({ digits: z.string() })

export type PayPalEvent =
  | { kind: "approved"; orderId: string }
  | { kind: "captured"; authorizationId: string; captureId: string }
  | { kind: "voided"; authorizationId: string }
  | { kind: "denied"; captureId: string }

type Deps = {
  paypal: PayPal
  placeCall: PlaceCall
  cards: Cards
  store: ErrandStore
  publicUrl: string
  sms?: Sms
  answerTimeoutMs?: number
  approvalTimeoutMs?: number
  collectAfterMs?: number
  collectRetryMs?: number
  pendingCheckMs?: number
  signupTimeoutMs?: number
  signupCheckMs?: number
}

export type Errands = ReturnType<typeof createErrands>

export function createErrands({
  paypal,
  placeCall,
  cards,
  store,
  publicUrl,
  sms,
  answerTimeoutMs = ANSWER_TIMEOUT_MS,
  approvalTimeoutMs = APPROVAL_TIMEOUT_MS,
  collectAfterMs = COLLECT_AFTER_MS,
  collectRetryMs = COLLECT_RETRY_MS,
  pendingCheckMs = PENDING_CHECK_MS,
  signupTimeoutMs = SIGNUP_TIMEOUT_MS,
  signupCheckMs = SIGNUP_CHECK_MS,
}: Deps) {
  const errands = new Map<string, Errand>()
  const calls = new Map<string, CallSession>()
  const pendingAnswers = new Map<string, { reply(text: string): void; wait(): boolean }>()
  const watchers = new Map<string, Set<(errand: Errand) => void>>()
  const pickupKeys = new Map<string, string>()
  const returnSecrets = new Map<string, string>()
  const settling = new Map<string, { step: string; done: Promise<void> }>()
  const proposing = new Set<string>()
  const joined = new Map<string, { email: string; merchantId: string }>()

  for (const { errand, pickupKey, returnSecret } of store.load()) {
    errands.set(errand.id, errand)
    pickupKeys.set(errand.id, pickupKey)
    returnSecrets.set(errand.id, returnSecret)
  }

  function once(id: string, step: string, work: () => Promise<void>): Promise<void> {
    const running = settling.get(id)
    if (running?.step === step) return running.done
    if (running) return Promise.reject(new Error(`Errand ${id} is still ${running.step}`))
    const done = work().finally(() => settling.delete(id))
    settling.set(id, { step, done })
    return done
  }

  function find(id: string): Errand {
    const errand = errands.get(id)
    if (!errand) throw new Error(`No errand ${id}`)
    return errand
  }

  function publish(errand: Errand) {
    errand.version += 1
    try {
      store.save({ errand, pickupKey: pickupKeys.get(errand.id)!, returnSecret: returnSecrets.get(errand.id)! })
    } catch (error) {
      console.error(`Errand ${errand.id} not saved: ${error}`)
    }
    for (const watcher of watchers.get(errand.id) ?? []) watcher(errand)
  }

  function setState(errand: Errand, state: ErrandState) {
    errand.state = state
    publish(errand)
  }

  function addLine(errand: Errand, speaker: Speaker, text: string) {
    errand.transcript.push({ speaker, text, at: new Date().toISOString() })
    publish(errand)
  }

  function fail(errand: Errand, reason: Extract<ErrandState, { kind: "failed" }>["reason"], detail: string) {
    setState(errand, { kind: "failed", reason, detail })
  }

  function settleFrom(errand: Errand, order: PayPalOrder) {
    if (errand.state.kind !== "authorized") return
    const { deal, orderId, receipt } = errand.state
    if (order.authorizationStatus === "CAPTURED") return setState(errand, { kind: "paid", deal, orderId, captureId: order.captureId ?? "", receipt })
    if (order.authorizationStatus === "VOIDED") return setState(errand, { kind: "voided", deal, orderId, receipt })
    if (order.authorizationStatus !== "CREATED") fail(errand, "paypal_error", `PayPal reports the hold as ${order.authorizationStatus ?? "missing"}, so it can no longer be collected.`)
  }

  function remember(errand: Errand) {
    try {
      cards.record(errand)
    } catch (error) {
      console.error(`Shop Card not saved for errand ${errand.id}: ${error}`)
    }
  }

  function askUser(errand: Errand, args: unknown): Promise<string> {
    const { question, options = [] } = askUserArgs.parse(args)
    if (errand.state.kind !== "calling" || proposing.has(errand.id)) return Promise.resolve("The customer cannot be asked now. Continue with the shop.")
    const until = () => new Date(Date.now() + answerTimeoutMs).toISOString()
    setState(errand, { kind: "asking", question, options, until: until(), waits: 0 })
    return new Promise((resolve) => {
      const expire = () => {
        pendingAnswers.delete(errand.id)
        if (errand.state.kind === "asking") fail(errand, "user_unavailable", `No answer to: ${question}`)
        resolve("The customer did not answer. Tell the shop the customer will call back, say goodbye, and call end_call.")
      }
      let timer = setTimeout(expire, answerTimeoutMs)
      pendingAnswers.set(errand.id, {
        reply(text) {
          clearTimeout(timer)
          pendingAnswers.delete(errand.id)
          resolve(text)
        },
        wait() {
          if (errand.state.kind !== "asking" || errand.state.waits >= MAX_WAITS) return false
          clearTimeout(timer)
          timer = setTimeout(expire, answerTimeoutMs)
          setState(errand, { ...errand.state, until: until(), waits: errand.state.waits + 1 })
          calls.get(errand.id)?.inform("The customer needs more time to answer. Ask the shop to hold a little longer, and thank them. Then wait for the answer.")
          return true
        },
      })
    })
  }

  async function proposeDeal(errand: Errand, args: unknown): Promise<string> {
    const raw = proposeDealArgs.parse(args)
    if (errand.state.kind === "signing_up") return "Rejected. Wait until Dial tells you that PayPal confirmed the shop's account."
    if (errand.state.kind !== "calling" || proposing.has(errand.id)) return "Rejected. A deal is already in place for this call. Do not propose another one."
    const deal: Deal = { items: raw.items, totalCents: raw.total_cents, pickupTime: raw.pickup_time, payeeEmail: raw.payee_email?.trim().toLowerCase() ?? null }
    const onFile = cards.get(errand.input.shop.phone)?.payeeEmail ?? joined.get(errand.id)?.email
    const problem = dealProblem(errand.input, deal, onFile)
    if (problem) {
      addLine(errand, "system", blockedLine(errand.input, deal, onFile))
      return `Rejected. ${problem}`
    }
    const receipt = { hash: receiptHash(errand.input.shop, deal, errand.transcript), lines: errand.transcript.length }
    if (deal.payeeEmail === null) {
      setState(errand, { kind: "pay_at_pickup", deal, receipt })
      remember(errand)
      return `Accepted. The customer pays ${formatUsd(deal.totalCents)} at pickup. Confirm the items and the pickup time with the shop, say goodbye, and call end_call.`
    }
    proposing.add(errand.id)
    try {
      const { orderId, approveUrl } = await paypal.createOrder({
        errandId: errand.id,
        totalCents: deal.totalCents,
        payeeEmail: deal.payeeEmail,
        payeeMerchantId: joined.get(errand.id)?.merchantId,
        description: `${errand.input.shop.name}: ${deal.items.map((item) => `${item.quantity} ${item.name}`).join(", ")}`,
        returnUrl: `${publicUrl}/paypal/return?errand=${errand.id}&back=${returnSecrets.get(errand.id)}`,
        cancelUrl: `${publicUrl}/paypal/cancel?errand=${errand.id}&back=${returnSecrets.get(errand.id)}`,
        customId: receipt.hash,
      })
      if (errand.state.kind !== "calling") return "The call has already ended."
      setState(errand, { kind: "awaiting_approval", deal, orderId, approveUrl, receipt, until: new Date(Date.now() + approvalTimeoutMs).toISOString() })
      setTimeout(() => approvalExpired(errand), approvalTimeoutMs).unref()
      return "Accepted. The customer is approving the PayPal payment now. Tell the shop this takes about a minute and ask them to hold. Do not end the call."
    } catch (error) {
      fail(errand, "paypal_error", error instanceof Error ? error.message : String(error))
      return "The payment could not be set up. Apologize, tell the shop the customer will call back, say goodbye, and call end_call."
    } finally {
      proposing.delete(errand.id)
    }
  }

  function approvalExpired(errand: Errand) {
    if (errand.state.kind !== "awaiting_approval" || settling.has(errand.id)) return
    fail(errand, "user_unavailable", "You did not approve the payment in time, so Dial said goodbye to the shop. No money moved.")
    calls.get(errand.id)?.inform("The customer did not approve the payment in time. Apologize, tell the shop the customer will call back, say goodbye, and call end_call.")
  }

  async function collect(errand: Errand, unclaimed: boolean) {
    if (errand.state.kind !== "authorized") throw new Error(`Errand ${errand.id} has no authorized payment`)
    const { deal, orderId, authorizationId, receipt } = errand.state
    const { captureId, pending } = await paypal.capture(authorizationId)
    setState(errand, { kind: "paid", deal, orderId, captureId, receipt, ...(pending && { pending }), ...(unclaimed && { unclaimed }) })
    followPending(errand)
  }

  function followPending(errand: Errand) {
    const check = setInterval(async () => {
      if (errand.state.kind !== "paid" || !errand.state.pending) return clearInterval(check)
      const order = await paypal.order(errand.state.orderId).catch((error) => console.error(`Pending payment for errand ${errand.id} not checked: ${error}`))
      if (!order || errand.state.kind !== "paid" || !errand.state.pending) return
      if (order.captureStatus === "COMPLETED") return setState(errand, { ...errand.state, pending: false })
      if (order.captureStatus === "DECLINED" || order.captureStatus === "FAILED") fail(errand, "paypal_error", "PayPal denied the payment after pickup, so the shop was not paid. Contact the shop.")
    }, pendingCheckMs)
    check.unref()
  }

  function collectLater(errand: Errand) {
    if (errand.state.kind !== "authorized") return
    const due = (tries: number) => {
      if (errand.state.kind !== "authorized") return
      once(errand.id, "capturing", () => collect(errand, true)).catch((error) => {
        console.error(`Unclaimed hold for errand ${errand.id} not collected: ${error}`)
        if (errand.state.kind !== "authorized") return
        if (tries === COLLECT_TRIES) return addLine(errand, "system", "Dial stopped trying to collect the hold. PayPal releases it when it expires, and you are not charged.")
        if (tries === 1) addLine(errand, "system", `PayPal did not collect the hold for ${errand.input.shop.name}. Dial tries again every hour.`)
        setTimeout(() => due(tries + 1), collectRetryMs).unref()
      })
    }
    setTimeout(() => due(1), Math.max(0, Date.parse(errand.state.collectBy) - Date.now())).unref()
  }

  async function signUpShop(errand: Errand): Promise<string> {
    const { shop, customerName } = errand.input
    if (errand.input.mode !== "order" || errand.state.kind !== "calling" || proposing.has(errand.id) || joined.has(errand.id)) return "The shop cannot sign up now. Continue with the shop."
    if (!sms) return "Dial cannot text the shop from this server. Tell the shop the customer pays at pickup, then call propose_deal with payee_email null."
    const onFile = cards.get(shop.phone)?.payeeEmail
    if (onFile) return `This shop already has a PayPal email on file: ${onFile}. Do not sign it up again. Confirm ${onFile} with the shop, or the customer pays at pickup.`
    proposing.add(errand.id)
    try {
      const { signupUrl } = await paypal.signUpShop(errand.id, `${publicUrl}/paypal/signed-up?errand=${errand.id}`)
      await sms.send(shop.phone, `${customerName} is ordering from ${shop.name} through Dial. Sign up for PayPal here to be paid for this order: ${signupUrl}`)
    } catch (error) {
      console.error(`Sign-up link for errand ${errand.id} not sent: ${error}`)
      return "The sign-up link could not be sent. Tell the shop the customer pays at pickup, then call propose_deal with payee_email null."
    } finally {
      proposing.delete(errand.id)
    }
    if (errand.state.kind !== "calling") return "The call has already ended."
    setState(errand, { kind: "signing_up", until: new Date(Date.now() + signupTimeoutMs).toISOString() })
    addLine(errand, "system", `Dial texted ${shop.name} a PayPal sign-up link`)
    const checks = setInterval(() => {
      if (errand.state.kind !== "signing_up") return clearInterval(checks)
      api.checkSignUp(errand.id).catch((error) => console.error(`Sign-up for errand ${errand.id} not checked: ${error}`))
    }, signupCheckMs).unref()
    setTimeout(() => signUpExpired(errand), signupTimeoutMs).unref()
    return "Dial texted the shop a PayPal sign-up link at this number. Tell the shop they can stay on the line while they sign up. Then wait quietly. Dial tells you when PayPal confirms the account."
  }

  function signUpExpired(errand: Errand) {
    if (errand.state.kind !== "signing_up" || settling.has(errand.id)) return
    setState(errand, { kind: "calling" })
    addLine(errand, "system", `${errand.input.shop.name} did not finish the PayPal sign-up in time`)
    calls.get(errand.id)?.inform("The shop did not finish the PayPal sign-up in time. Tell the shop they can finish it later, for next time. The customer pays at pickup: call propose_deal with payee_email null.")
  }

  function pressKeys(errand: Errand, args: unknown): string {
    const digits = pressKeysArgs.parse(args).digits.replace(/[\s,-]/g, "")
    if (!KEYPAD.test(digits)) return "Use only the digits 0 to 9, * and #."
    calls.get(errand.id)?.press(digits)
    addLine(errand, "system", `Dial pressed ${digits}`)
    return `Pressed ${digits}. Listen for the next prompt.`
  }

  async function runTool(errand: Errand, name: string, args: unknown): Promise<string> {
    switch (name) {
      case "ask_user":
        return askUser(errand, args)
      case "propose_deal":
        return proposeDeal(errand, args)
      case "report_findings": {
        const { summary } = reportFindingsArgs.parse(args)
        if (errand.state.kind !== "calling") return "The findings are already reported. Say goodbye and call end_call."
        setState(errand, { kind: "answered", findings: summary })
        return "Thanks. Say goodbye and call end_call."
      }
      case "press_keys":
        return pressKeys(errand, args)
      case "sign_up_shop":
        return signUpShop(errand)
      case "end_call":
        calls.get(errand.id)?.hangup()
        return "Call ended."
      default:
        return `Unknown tool ${name}.`
    }
  }

  function callEnded(errand: Errand, unreached?: Unreached) {
    calls.delete(errand.id)
    pendingAnswers.delete(errand.id)
    const shop = errand.input.shop.name
    addLine(errand, "system", "Call ended")
    if (unreached && errand.state.kind === "calling") {
      if (unreached === "failed") return fail(errand, "call_error", `The call to ${shop} did not connect. No money moved.`)
      const why = { busy: `${shop}'s line was busy.`, no_answer: `${shop} did not pick up.`, voicemail: `The call reached ${shop}'s voicemail, so Dial hung up without leaving a message.` }[unreached]
      return fail(errand, "no_answer", `${why} No money moved.`)
    }
    if (errand.state.kind === "awaiting_approval")
      return fail(errand, "no_deal", `${shop} hung up before you approved the payment. No money moved.`)
    if (errand.state.kind !== "calling" && errand.state.kind !== "asking" && errand.state.kind !== "signing_up") return
    const blocked = errand.transcript.findLast((line) => line.speaker === "system" && line.text.startsWith("Blocked: "))
    fail(errand, "no_deal", blocked ? `${blocked.text.replace(/^Blocked: /, "")} The call ended with no order.` : "The call ended before the shop agreed an order.")
  }

  const api = {
    async recover(): Promise<void> {
      for (const errand of errands.values()) {
        if (errand.state.kind === "paid" && errand.state.pending) followPending(errand)
        if (isFinished(errand.state)) continue
        if (errand.state.kind === "calling" || errand.state.kind === "asking" || errand.state.kind === "signing_up") {
          fail(errand, "call_error", "Dial restarted during the call, so the call ended. No money moved.")
          continue
        }
        if (errand.state.kind === "awaiting_approval") {
          const order = await paypal.order(errand.state.orderId).catch((error) => console.error(`Errand ${errand.id}: PayPal could not be checked after a restart: ${error}`))
          if (order?.authorizationStatus === "CREATED" && order.authorizationId)
            await paypal.void(order.authorizationId).catch((error) => console.error(`Hold ${order.authorizationId} for errand ${errand.id} not voided: ${error}`))
          fail(errand, "no_deal", "Dial restarted while you were approving, so the call ended. No money moved.")
          continue
        }
        if (errand.state.kind !== "authorized") continue
        const order = await paypal.order(errand.state.orderId).catch((error) => {
          if (error instanceof PayPalError && error.status === 404) return fail(errand, "paypal_error", "After a restart PayPal had no record of this order.")
          console.error(`Errand ${errand.id} kept after a restart; PayPal could not be checked: ${error}`)
        })
        if (order) settleFrom(errand, order)
        collectLater(errand)
      }
    },

    async start(input: ErrandInput): Promise<Errand> {
      if (input.mode === "order" && input.maxCents > LIMIT_CEILING_CENTS) throw new Error(`Dial orders up to ${formatUsd(LIMIT_CEILING_CENTS)} at a time.`)
      const errand: Errand = {
        id: crypto.randomUUID(),
        input,
        state: { kind: "calling" },
        transcript: [],
        version: 0,
        createdAt: new Date().toISOString(),
      }
      errands.set(errand.id, errand)
      pickupKeys.set(errand.id, crypto.randomUUID())
      returnSecrets.set(errand.id, crypto.randomUUID())
      try {
        const call = await placeCall({ errandId: errand.id, input }, briefFor(input, cards.get(input.shop.phone)), {
          onLine: (speaker, text) => addLine(errand, speaker, text),
          onToolCall: (name, args) => runTool(errand, name, args),
          onEnded: (_detail, unreached) => callEnded(errand, unreached),
        })
        calls.set(errand.id, call)
      } catch (error) {
        fail(errand, "call_error", error instanceof Error ? error.message : String(error))
      }
      return errand
    },

    get: (id: string): Errand | undefined => errands.get(id),
    list: (): Errand[] => [...errands.values()],

    pickupKey: (id: string): string | undefined => pickupKeys.get(id),

    signedUp: (id: string): boolean => joined.has(id),

    fromPayPal: (id: string, back: string | undefined): boolean => Boolean(back) && returnSecrets.get(id) === back,

    card: (phone: string) => cards.get(phone),

    async receipt(id: string): Promise<ReceiptView | undefined> {
      const errand = errands.get(id)
      if (!errand || !("receipt" in errand.state)) return
      const { deal, receipt } = errand.state
      const orderId = "orderId" in errand.state ? errand.state.orderId : null
      const read = orderId ? await paypal.order(orderId).then((order) => ({ customId: order.customId, error: null }), (error) => ({ customId: null, error: String(error.message ?? error) })) : { customId: null, error: null }
      const { name, phone } = errand.input.shop
      return { shop: { name, phone }, deal, lines: errand.transcript.slice(0, receipt.lines), hash: receipt.hash, orderId, payPalCustomId: read.customId, payPalError: read.error, outcome: errand.state.kind }
    },

    answer(id: string, answer: string) {
      const pending = pendingAnswers.get(id)
      if (!pending) throw new Error(`Errand ${id} has no open question`)
      setState(find(id), { kind: "calling" })
      pending.reply(`The customer answered: ${answer}`)
    },

    wait(id: string): boolean {
      const pending = pendingAnswers.get(id)
      if (!pending) throw new Error(`Errand ${id} has no open question`)
      return pending.wait()
    },

    hangUp(id: string) {
      const errand = find(id)
      if (errand.state.kind !== "calling" && errand.state.kind !== "asking" && errand.state.kind !== "signing_up") throw new Error(`Errand ${id} has no call to end`)
      fail(errand, "user_cancelled", "Dial said goodbye to the shop. No money moved.")
      const goodbye = "The customer ended the call. Apologize to the shop, say goodbye, and call end_call."
      const pending = pendingAnswers.get(id)
      const call = calls.get(id)
      if (pending) pending.reply(goodbye)
      else call?.inform(goodbye)
      setTimeout(() => call?.hangup(), GOODBYE_MS).unref()
    },

    checkSignUp: (id: string) => once(id, "joining", async () => {
      const errand = find(id)
      if (errand.state.kind !== "signing_up") return
      const shop = await paypal.signedUpShop(id)
      if (!shop?.ready || !shop.email || errand.state.kind !== "signing_up") return
      const email = shop.email.trim().toLowerCase()
      joined.set(id, { email, merchantId: shop.merchantId })
      setState(errand, { kind: "calling" })
      addLine(errand, "system", `PayPal confirmed the new account for ${errand.input.shop.name}`)
      calls.get(id)?.inform(`PayPal confirms the shop's new account, ${email}. Tell the shop the account is ready, and welcome them to PayPal. Then call propose_deal with payee_email ${email}.`)
    }),

    approved: (id: string) => once(id, "authorizing", async () => {
      const errand = find(id)
      if (errand.state.kind !== "awaiting_approval") throw new Error(`Errand ${id} is not awaiting approval`)
      const { deal, orderId, receipt } = errand.state
      const order = await paypal.order(orderId)
      const held = order.authorizationStatus === "CREATED" ? order.authorizationId : null
      if (!held && order.status !== "APPROVED") throw new Error(`Order ${orderId} is ${order.status} on PayPal, not approved`)
      const authorizationId = held ?? await paypal
        .authorize(orderId)
        .then(
          (result) => result.authorizationId,
          (error) => paypal.order(orderId).then((order) => (order.authorizationStatus === "CREATED" && order.authorizationId) || Promise.reject(error)),
        )
        .catch((error) => {
          fail(errand, "paypal_error", error instanceof Error ? error.message : String(error))
          calls.get(id)?.inform("The payment failed. Apologize, tell the shop the customer will call back, say goodbye, and call end_call.")
          return null
        })
      if (!authorizationId) return
      if (errand.state.kind !== "awaiting_approval") {
        await paypal.void(authorizationId).catch((error) => console.error(`Hold ${authorizationId} for errand ${id} not voided: ${error}`))
        return
      }
      setState(errand, { kind: "authorized", deal, orderId, authorizationId, receipt, collectBy: new Date(Date.now() + collectAfterMs).toISOString() })
      remember(errand)
      collectLater(errand)
      const customer = errand.input.customerName
      calls
        .get(id)
        ?.inform(
          `Payment authorized: ${formatUsd(deal.totalCents)} to ${deal.payeeEmail} on PayPal. Tell the shop: the payment is held on PayPal. ${customer} pays at the counter, so hand the order over once PayPal shows the payment. If ${customer} does not come within a day, the shop is paid anyway. Then thank them, say goodbye, and call end_call.`,
        )
    }),

    declined: (id: string) => once(id, "declining", async () => {
      const errand = find(id)
      if (errand.state.kind !== "awaiting_approval") throw new Error(`Errand ${id} is not awaiting approval`)
      fail(errand, "user_declined", "You cancelled on PayPal, so no money moved. Dial told the shop.")
      calls.get(id)?.inform("The customer declined the payment. Apologize to the shop, say goodbye, and call end_call.")
    }),

    confirmPickup: (id: string, receivedAsAgreed: boolean) => once(id, receivedAsAgreed ? "capturing" : "voiding", async () => {
      const errand = find(id)
      if (errand.state.kind !== "authorized") throw new Error(`Errand ${id} has no authorized payment`)
      if (receivedAsAgreed) return collect(errand, false)
      const { deal, orderId, authorizationId, receipt } = errand.state
      await paypal.void(authorizationId)
      setState(errand, { kind: "voided", deal, orderId, receipt })
    }),

    reconcile: async (event: PayPalEvent): Promise<void> => {
      if (event.kind === "approved") {
        const waiting = [...errands.values()].find((e) => e.state.kind === "awaiting_approval" && e.state.orderId === event.orderId)
        if (waiting) await api.approved(waiting.id)
        return
      }
      if (event.kind === "captured" || event.kind === "denied") {
        const paid = [...errands.values()].find((e) => e.state.kind === "paid" && e.state.pending && e.state.captureId === event.captureId)
        if (paid?.state.kind === "paid") {
          if (event.kind === "captured") return setState(paid, { ...paid.state, pending: false })
          return fail(paid, "paypal_error", "PayPal denied the payment after pickup, so the shop was not paid. Contact the shop.")
        }
        if (event.kind === "denied") return
      }
      const held = [...errands.values()].find((e) => e.state.kind === "authorized" && e.state.authorizationId === event.authorizationId)
      if (!held) return
      await once(held.id, event.kind === "captured" ? "capturing" : "voiding", async () => {
        const { state } = held
        if (state.kind !== "authorized") return
        const { deal, orderId, receipt } = state
        setState(held, event.kind === "captured" ? { kind: "paid", deal, orderId, captureId: event.captureId, receipt } : { kind: "voided", deal, orderId, receipt })
      })
    },

    watch(id: string, watcher: (errand: Errand) => void): () => void {
      const set = watchers.get(id) ?? new Set()
      set.add(watcher)
      watchers.set(id, set)
      return () => set.delete(watcher)
    },
  }
  return api
}

function blockedLine(input: ErrandInput, deal: Deal, payeeOnFile: string | null | undefined): string {
  if (input.mode === "order" && deal.totalCents > input.maxCents)
    return `Blocked: The shop asked for ${formatUsd(deal.totalCents)}, above your ${formatUsd(input.maxCents)} limit. Dial said no.`
  if (payeeOnFile && deal.payeeEmail && !sameEmail(deal.payeeEmail, payeeOnFile))
    return "Blocked: The shop gave a different PayPal email than the one on file. Dial said no."
  return "Blocked: The shop's terms broke your rules, so Dial said no."
}
