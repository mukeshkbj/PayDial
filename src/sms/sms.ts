export type Sms = { send(to: string, body: string): Promise<void> }

export type SmsMessage = { phone: string; direction: "in" | "out"; body: string; at: string }

export type FakeSms = Sms & { thread(phone: string): SmsMessage[]; received(phone: string, body: string): void }

export function fakeSms(): FakeSms {
  const threads = new Map<string, SmsMessage[]>()
  const record = (phone: string, direction: SmsMessage["direction"], body: string) => {
    const thread = threads.get(phone) ?? []
    thread.push({ phone, direction, body, at: new Date().toISOString() })
    threads.set(phone, thread)
  }
  return {
    async send(to, body) {
      record(to, "out", body)
    },
    thread: (phone) => [...(threads.get(phone) ?? [])],
    received: (phone, body) => record(phone, "in", body),
  }
}
