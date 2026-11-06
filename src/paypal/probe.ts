import type { PayPal } from "./rest.ts"

type Log = (line: string) => void

export async function startProbe(paypal: PayPal, payeeEmail: string, log: Log) {
  const { orderId, approveUrl } = await paypal.createOrder({
    errandId: `probe-${Date.now()}`,
    totalCents: 100,
    payeeEmail,
    description: "Dial sandbox probe",
    returnUrl: "https://example.com/dial-probe",
    cancelUrl: "https://example.com/dial-probe",
    customId: "probe",
  })
  log(`order ${orderId}`)
  log(`approve URL ${approveUrl}`)
  log(`Open the approve URL, approve with a sandbox buyer account, then run: npm run probe:paypal -- finish ${orderId} capture`)
  return { orderId, approveUrl }
}

export async function finishProbe(paypal: PayPal, orderId: string, action: "capture" | "void", log: Log) {
  const { authorizationId } = await paypal.authorize(orderId)
  log(`authorization ${authorizationId}`)
  let captureId: string | null = null
  if (action === "capture") {
    captureId = (await paypal.capture(authorizationId)).captureId
    log(`capture ${captureId}`)
  } else {
    await paypal.void(authorizationId)
    log(`voided ${authorizationId}`)
  }
  const { status: orderStatus, authorizationStatus } = await paypal.order(orderId)
  log(`order status ${orderStatus}`)
  log(`authorization status ${authorizationStatus}`)
  return { authorizationId, captureId, orderStatus, authorizationStatus }
}
