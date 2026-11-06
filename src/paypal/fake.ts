import { PayPalError, type OrderRequest, type PayPal } from "./rest.ts"

type FakeOrder = OrderRequest & {
  id: string
  status: "CREATED" | "APPROVED" | "COMPLETED"
  authorization?: { id: string; status: "CREATED" | "CAPTURED" | "VOIDED"; captureId?: string }
}

export type FakePayPal = PayPal & {
  peek(orderId: string): FakeOrder | undefined
  approve(orderId: string): string
  cancel(orderId: string): string
  signup(trackingId: string): { returnUrl: string } | undefined
  finishSignUp(trackingId: string, email: string): string
}

export function fakePayPal(publicUrl: string): FakePayPal {
  const orders = new Map<string, FakeOrder>()
  const signups = new Map<string, { returnUrl: string; email?: string }>()
  let sequence = 0

  function find(orderId: string): FakeOrder {
    const order = orders.get(orderId)
    if (!order) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: `Fake PayPal: no order ${orderId}` })
    return order
  }

  function findAuthorization(authorizationId: string) {
    const authorization = [...orders.values()].find((o) => o.authorization?.id === authorizationId)?.authorization
    if (!authorization) throw new Error(`Fake PayPal: no authorization ${authorizationId}`)
    return authorization
  }

  return {
    peek: (orderId) => orders.get(orderId),

    order: async (orderId) => {
      const order = find(orderId)
      return {
        status: order.status,
        customId: order.customId,
        authorizationId: order.authorization?.id ?? null,
        authorizationStatus: order.authorization?.status ?? null,
        captureId: order.authorization?.captureId ?? null,
        captureStatus: order.authorization?.captureId ? "COMPLETED" : null,
      }
    },

    approve(orderId) {
      const order = find(orderId)
      if (order.status !== "CREATED") throw new Error(`Fake PayPal: order ${orderId} is ${order.status}`)
      order.status = "APPROVED"
      return `${order.returnUrl}&token=${orderId}`
    },

    cancel(orderId) {
      const order = find(orderId)
      return `${order.cancelUrl}&token=${orderId}`
    },

    verifyWebhook: async () => false,

    signup: (trackingId) => signups.get(trackingId),

    finishSignUp(trackingId, email) {
      const signup = signups.get(trackingId)
      if (!signup) throw new Error(`Fake PayPal: no sign-up ${trackingId}`)
      signup.email = email.trim().toLowerCase()
      return signup.returnUrl
    },

    async signUpShop(trackingId, returnUrl) {
      signups.set(trackingId, { returnUrl })
      return { signupUrl: `${publicUrl}/fake-paypal/signup/${trackingId}` }
    },

    async signedUpShop(trackingId) {
      const email = signups.get(trackingId)?.email
      return email ? { merchantId: `FAKE-MERCHANT-${trackingId.slice(0, 8)}`, email, ready: true } : null
    },

    async createOrder(request) {
      sequence += 1
      const id = `FAKE-ORDER-${sequence}`
      orders.set(id, { ...request, id, status: "CREATED" })
      return { orderId: id, approveUrl: `${publicUrl}/fake-paypal/${id}` }
    },

    async authorize(orderId) {
      const order = find(orderId)
      if (order.status !== "APPROVED") throw new Error(`Fake PayPal: cannot authorize order ${orderId} in status ${order.status}`)
      order.status = "COMPLETED"
      order.authorization = { id: `FAKE-AUTH-${orderId.split("-").at(-1)}`, status: "CREATED" }
      return { authorizationId: order.authorization.id }
    },

    async capture(authorizationId) {
      const authorization = findAuthorization(authorizationId)
      if (authorization.status !== "CREATED") throw new Error(`Fake PayPal: authorization is ${authorization.status}`)
      authorization.status = "CAPTURED"
      authorization.captureId = `FAKE-CAPTURE-${authorizationId.split("-").at(-1)}`
      return { captureId: authorization.captureId, pending: false }
    },

    async void(authorizationId) {
      const authorization = findAuthorization(authorizationId)
      if (authorization.status !== "CREATED") throw new Error(`Fake PayPal: authorization is ${authorization.status}`)
      authorization.status = "VOIDED"
    },
  }
}
