# PayPal sandbox probe (2026-11-09)

The probe (`npm run probe:paypal`) ran on the builder's Windows PC (Node 24.21.0) against `https://api-m.sandbox.paypal.com`, through Dial's own PayPal REST adapter (`src/paypal/rest.ts`). The API app's credentials were set in `.env`. The payee was a separate sandbox business account (region GB), not the API app's own account. A sandbox personal account approved each order on PayPal's checkout page.

It answers the open question in the design: PayPal's sandbox accepts an `intent: AUTHORIZE` order whose `payee` is a different account from the API caller, and lets the caller capture or void that authorization.

## Capture path

`start sb-9uog953805599@business.example.com`, approved by the buyer, then `finish 74L97138GW536232N capture`:

| Step | PayPal ID | Status PayPal reported |
|---|---|---|
| Order | `74L97138GW536232N` | `COMPLETED` |
| Authorization | `3EN568103R254680H` | `CAPTURED` |
| Capture | `7W6100057T015460X` | |

## Void path

`start sb-9uog953805599@business.example.com`, approved by the buyer, then `finish 7GR54420F4435353J void`:

| Step | PayPal ID | Status PayPal reported |
|---|---|---|
| Order | `7GR54420F4435353J` | `COMPLETED` |
| Authorization | `8B801015KV063973J` | `VOIDED` |

## What this does not show

- It is the sandbox. Production may still require PayPal Complete Payments approval before a platform can pay sellers it does not own.
- The order was $1.00 USD to a GB account, and the capture did not come back pending. Other currency and region pairs were not tried.
- The full app loop on sandbox money (`npm run dev`, then `npm run proof`) has not run yet. Neither has Partner Referrals (shop sign-up) or the webhook route.
