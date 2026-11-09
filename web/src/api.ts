import { useEffect, useState } from "react"
import type { ShopCard } from "../../src/cards.ts"
import { isFinished, type Errand, type ErrandInput } from "../../src/domain/errand.ts"
import type { Menu, Place } from "../../src/places/places.ts"
import type { Online } from "../../src/products/channel3.ts"
import type { ReceiptView } from "../../src/receipt.ts"
import type { SmsMessage } from "../../src/sms/sms.ts"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } })
  const body = await res.json()
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed with ${res.status}`), { status: res.status })
  return body
}

export type Listed = Place & { card: ShopCard | null }

export function verifiedOn(card: ShopCard) {
  return new Date(card.verifiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export const api = {
  online: (q: string) => request<{ source: "channel3" | "none"; online: Online[] }>(`/api/online?${new URLSearchParams({ q })}`),
  config: () => request<{ shopLine: boolean; payPal: "simulated" | "sandbox" }>("/api/config"),
  searchShops: (q: string, near: string) => request<Listed[]>(`/api/shops?${new URLSearchParams({ q, near })}`),
  shop: (id: string) => request<{ place: Place; menu: Menu | null; card: ShopCard | null }>(`/api/shops/${id}`),
  startErrand: (input: ErrandInput) => request<Errand & { pickupKey: string }>("/api/errands", { method: "POST", body: JSON.stringify(input) }),
  receipt: (id: string) => request<ReceiptView>(`/api/errands/${id}/receipt`),
  answer: (id: string, text: string) => request(`/api/errands/${id}/answer`, { method: "POST", body: JSON.stringify({ text }) }),
  wait: (id: string) => request<{ ok: boolean }>(`/api/errands/${id}/wait`, { method: "POST" }),
  hangUp: (id: string) => request(`/api/errands/${id}/hangup`, { method: "POST" }),
  pickup: (id: string, receivedAsAgreed: boolean, key: string) =>
    request(`/api/errands/${id}/pickup`, { method: "POST", body: JSON.stringify({ receivedAsAgreed, key }) }),
  thread: (phone: string) => request<SmsMessage[]>(`/api/text/${encodeURIComponent(phone)}`),
  text: (phone: string, body: string) => request<SmsMessage[]>("/api/text", { method: "POST", body: JSON.stringify({ phone, body }) }),
  shopSays: (id: string, text: string) => request(`/api/errands/${id}/shop`, { method: "POST", body: JSON.stringify({ text }) }),
}

export function useErrand(id: string): Errand | null | undefined {
  const [errand, setErrand] = useState<Errand | null>()
  useEffect(() => {
    const source = new EventSource(`/api/errands/${id}/events`)
    source.onmessage = (event) => {
      const next: Errand = JSON.parse(event.data)
      setErrand(next)
      if (isFinished(next.state)) source.close()
    }
    source.onerror = () =>
      void fetch(`/api/errands/${id}`).then((res) => {
        if (res.status !== 404) return
        source.close()
        setErrand(null)
      })
    return () => source.close()
  }, [id])
  return errand
}

let simulated: Promise<boolean> | undefined

export function useSimulated(): boolean {
  const [value, setValue] = useState(true)
  useEffect(() => {
    simulated ??= api.config().then((config) => config.payPal === "simulated")
    void simulated.then(setValue)
  }, [])
  return value
}

export function pickupKey(id: string): string | null {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("key")
  if (fromLink) localStorage.setItem(`dial:key:${id}`, fromLink)
  return fromLink ?? localStorage.getItem(`dial:key:${id}`)
}

export function navigate(path: string) {
  history.pushState(null, "", path)
  dispatchEvent(new PopStateEvent("popstate"))
}
