# Research: Dial feasibility (2026-10-18)

Condensed from the Sonnet 5.5 feasibility agent. No live sandbox calls were made. The envsync vault has `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`. It has no PayPal secret and no Twilio, Vapi or Retell keys.

## PayPal

- Payouts recipient types: EMAIL, PHONE, PAYPAL_ID, USER_HANDLE (Venmo). **PHONE is not supported in sandbox.** https://developer.paypal.com/api/payments.payouts-batch/v1/definitions/create_payout_request
- Unregistered recipient: UNCLAIMED, money returns after 30 days. Sandbox may instead return `RECEIVER_UNREGISTERED`. Day-1 test.
- Payouts webhooks: `PAYMENT.PAYOUTSBATCH.*`, `PAYMENT.PAYOUTS-ITEM.*`. Async by default. `sender_batch_id` is idempotent for 30 days.
- **Payouts Agreement (28 Apr 2026): live use needs permission, and Payouts is "not [for] payroll, one-off payments, or family transfers."** A one-off payment to a shop conflicts with this in production. https://www.paypal.com/legalhub/paypal-payouts-agreement
- Orders AUTHORIZE: valid 29 days, honor period 3 days. Partial capture allowed but "must be enabled on your PayPal account" (day-1 test). Capture above the hold is allowed up to 115% or +$75, whichever is less. AUTHORIZE allows one purchase unit only. Void, reauthorize, refund exist.
- JS SDK v6: `createInstance`, `createPayPalOneTimePaymentSession`, `session.start({presentationMode:"auto"}, orderPromise)`. Do not await order creation before `start`. AUTHORIZE end to end in v6 is not shown in the docs; the server calls `/v2/checkout/orders/{id}/authorize` after approval.
- Production route for paying third-party shops: PayPal Complete Payments (multiparty), which needs PayPal approval for live use. Sandbox use before approval is unverified.

## Voice

- Fastest solo stack: Vapi ($0.05/min platform, $5 credit) or Retell ($10 credit). Cheapest: Pipecat or LiveKit with Gemini Live (free tier).
- OpenAI Realtime outbound SIP needs org enablement. Do not depend on it.
- Twilio trial: verified numbers only, 75 minutes, 30 days, sign-up country only, template SMS. Paid US outbound $0.014/min.
- Judges outside the US: use a browser softphone (Twilio Voice JS SDK, or the voice platform's web-call SDK).

## Legal (not legal advice)

- FCC 24-17 (Feb 2024): AI voices count as "artificial" under the TCPA. Calls to business lines get more latitude, business cell numbers are a grey area.
- Use an opening disclosure plus a transcription consent question. Judges tick an express-consent box before any call to their number.

## Evidence for the pitch

- 83% of US small businesses have a website (Clutch, Aug 2025), so about 17% have none.
- 29% of direct takeout diners usually order by phone (TouchBistro 2024).
- 37.5M US adults report trouble hearing (NIDCD via NCOA). WHO: 1.5B people globally have some hearing loss.
- UK poll (BT, 2019): only 1 in 20 deaf or hard-of-hearing people can complete tasks over the phone.
- Gen Z phone anxiety: about 60% dread calls (Murdoch University, 2023, Australia).
- No reliable share of phone-only bakeries or restaurants was found.

## Precedents (limits the novelty claim)

- **Google "Ask for Me" / AI Mode calling** went to all US users in July 2025. It calls local businesses for availability and price, and expanded to home repair, beauty and pet care in 2026. **It does not pay the business.**
- Google Duplex (2018) booked restaurant reservations by phone.
- Pine AI calls companies to cut bills. It does not pay.
- Restaurant-side voice ordering (Slang, Loman, Kea, Palona) needs the restaurant to opt in.
- Defensible claim: "To our knowledge, the first consumer-side agent that phones a shop with no integration, agrees the order, and settles payment from a hold the user pre-approved." Say "to our knowledge."
