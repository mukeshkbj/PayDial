const HUES: Record<string, number> = {
  "Sam's Bagels": 72,
  "Rosa's Panadería": 352,
  "Tony's Pizza": 32,
  "Corner Deli": 150,
  "Mei's Dumplings": 18,
  "Greens Pharmacy": 240,
}

export function shopHue(name: string): number {
  return HUES[name] ?? [...name].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 360, 7)
}

export const SCENARIOS: Record<string, { title: string; story: string }> = {
  "sim:happy": { title: "Takes PayPal", story: "Quotes a price, gives a PayPal email, and waits on the line while you approve." },
  "sim:out_of_stock": { title: "Out of stock", story: "Runs out of what you picked. Dial asks you before it agrees to a swap." },
  "sim:price_injection": { title: "Tries to overcharge", story: "Demands $500 for an AI order. The money gate blocks it and Dial renegotiates." },
  "sim:no_paypal": { title: "No PayPal", story: "Takes cash or card only. You get the order and pay in store." },
  "sim:new_to_paypal": { title: "Joins PayPal on the call", story: "Has no PayPal. Dial texts a sign-up link, PayPal confirms the new account, and the shop is paid." },
  "sim:inquiry": { title: "Question only", story: "No menu online. Dial asks your question and reports the answer." },
}

export function morph(part: string, id: string): string {
  return `${part}-${id.replace(/[^a-z0-9-]/gi, "")}`
}
