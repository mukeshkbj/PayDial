import { createHash } from "node:crypto"
import type { Cents } from "../domain/errand.ts"

export type OrderRequest = {
  errandId: string
  totalCents: Cents
  payeeEmail: string
  payeeMerchantId?: string
  description: string
  returnUrl: string
  cancelUrl: string
  customId: string
}

export type PayPal = {
  createOrder(order: OrderRequest): Promise<{ orderId: string; approveUrl: string }>
  authorize(orderId: string): Promise<{ authorizationId: string }>
  capture(authorizationId: string): Promise<{ captureId: string; pending: boolean }>
  void(authorizationId: string): Promise<void>
  order(orderId: string): Promise<PayPalOrder>
  verifyWebhook(headers: Record<string, string>, event: unknown): Promise<boolean>
  signUpShop(trackingId: string, returnUrl: string): Promise<{ signupUrl: string }>
  signedUpShop(trackingId: string): Promise<SignedUpShop | null>
}

export type SignedUpShop = { merchantId: string; email: string | null; ready: boolean }

export type PayPalOrder = {
  status: string
  customId: string | null
  authorizationId: string | null
  authorizationStatus: string | null
  captureId: string | null
  captureStatus: string | null
}

export class PayPalError extends Error {
  readonly status: number
  readonly debugId: string | undefined

  constructor(status: number, body: { message?: string; debug_id?: string; name?: string; details?: { issue?: string }[] }) {
    const issues = body.details?.map((detail) => detail.issue).filter(Boolean).join(", ")
    super(`PayPal ${status} ${body.name ?? ""}${issues ? ` ${issues}` : ""}: ${body.message ?? "request failed"} (debug_id ${body.debug_id ?? "none"})`)
    this.status = status
    this.debugId = body.debug_id
  }
}

type Credentials = { clientId: string; clientSecret: string; baseUrl: string; webhookId?: string; partnerId?: string }

export function restPayPal({ clientId, clientSecret, baseUrl, webhookId, partnerId }: Credentials): PayPal {
  let token: { value: string; expiresAt: number } | undefined

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value
    const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    })
    const body = await res.json()
    if (!res.ok) throw new PayPalError(res.status, { message: body.error_description, name: body.error })
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return token.value
  }

  async function post(path: string, requestId: string, payload?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload ?? {}),
    })
    return read(res)
  }

  async function get(path: string) {
    return read(await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` } }))
  }

  async function read(res: Response) {
    const text = await res.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { message: text.slice(0, 200) }
    }
    if (!res.ok) throw new PayPalError(res.status, body)
    return body
  }

  return {
    async createOrder(order) {
      const body = await post("/v2/checkout/orders", `${order.errandId}-create`, {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: order.errandId,
            description: order.description.slice(0, 127),
            amount: { currency_code: "USD", value: (order.totalCents / 100).toFixed(2) },
            payee: order.payeeMerchantId ? { merchant_id: order.payeeMerchantId } : { email_address: order.payeeEmail },
            custom_id: order.customId,
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Dial",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: order.returnUrl,
              cancel_url: order.cancelUrl,
            },
          },
        },
      })
      const approve = body.links?.find((link: { rel: string }) => link.rel === "payer-action" || link.rel === "approve")
      if (!approve) throw new Error(`PayPal created order ${body.id} with no approval link`)
      return { orderId: body.id, approveUrl: approve.href }
    },

    async authorize(orderId) {
      const body = await post(`/v2/checkout/orders/${orderId}/authorize`, `${orderId}-authorize`)
      const authorization = body.purchase_units[0].payments.authorizations[0]
      if (authorization.status !== "CREATED") throw new Error(`PayPal answered the hold with status ${authorization.status}`)
      return { authorizationId: authorization.id }
    },

    async capture(authorizationId) {
      const body = await post(`/v2/payments/authorizations/${authorizationId}/capture`, `${authorizationId}-capture`, {
        final_capture: true,
      })
      if (body.status !== "COMPLETED" && body.status !== "PENDING") throw new Error(`PayPal answered the capture with status ${body.status}`)
      return { captureId: body.id, pending: body.status === "PENDING" }
    },

    async void(authorizationId) {
      await post(`/v2/payments/authorizations/${authorizationId}/void`, `${authorizationId}-void`)
    },

    async order(orderId) {
      const body = await get(`/v2/checkout/orders/${orderId}`)
      const unit = body.purchase_units[0]
      const authorization = unit.payments?.authorizations?.[0]
      return {
        status: body.status,
        customId: unit.custom_id ?? null,
        authorizationId: authorization?.id ?? null,
        authorizationStatus: authorization?.status ?? null,
        captureId: unit.payments?.captures?.[0]?.id ?? null,
        captureStatus: unit.payments?.captures?.[0]?.status ?? null,
      }
    },

    async verifyWebhook(headers, event) {
      if (!webhookId) return false
      const transmissionId = headers["paypal-transmission-id"]
      const body = await post("/v1/notifications/verify-webhook-signature", `${transmissionId}-${createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 16)}`, {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: transmissionId,
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      })
      return body.verification_status === "SUCCESS"
    },

    async signUpShop(trackingId, returnUrl) {
      if (!partnerId) throw new Error("Shop sign-up needs PAYPAL_PARTNER_ID.")
      const body = await post("/v2/customer/partner-referrals", `${trackingId}-signup`, {
        tracking_id: trackingId,
        operations: [
          {
            operation: "API_INTEGRATION",
            api_integration_preference: {
              rest_api_integration: { integration_method: "PAYPAL", integration_type: "THIRD_PARTY", third_party_details: { features: ["PAYMENT", "REFUND"] } },
            },
          },
        ],
        products: ["EXPRESS_CHECKOUT"],
        legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
        partner_config_override: { return_url: returnUrl },
      })
      return { signupUrl: body.links.find((link: { rel: string }) => link.rel === "action_url").href }
    },

    async signedUpShop(trackingId) {
      if (!partnerId) throw new Error("Shop sign-up needs PAYPAL_PARTNER_ID.")
      const found = await get(`/v1/customer/partners/${partnerId}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`).catch((error) => {
        if (error instanceof PayPalError && error.status === 404) return null
        throw error
      })
      if (!found?.merchant_id) return null
      const status = await get(`/v1/customer/partners/${partnerId}/merchant-integrations/${found.merchant_id}`)
      const consented = (status.oauth_integrations ?? []).some((integration: { integration_type?: string }) => integration.integration_type === "OAUTH_THIRD_PARTY")
      return { merchantId: found.merchant_id, email: status.primary_email ?? null, ready: status.payments_receivable === true && status.primary_email_confirmed === true && consented }
    },
  }
}
