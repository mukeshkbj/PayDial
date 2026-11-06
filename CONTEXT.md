# Dial

Dial phones a local shop for a customer, agrees a pickup order, and pays the shop through PayPal while the shop is still on the line.

## People

**Customer**:
The person Dial calls for. The customer approves payments and answers questions.
_Avoid_: User, buyer, caller

**Shop**:
The local business that Dial phones. The shop has no integration with Dial.
_Avoid_: Merchant, store, vendor

**Agent**:
The AI voice that speaks to the shop for the customer.
_Avoid_: Bot, assistant, Dial (when the voice is meant)

## The errand

**Errand**:
One call to one shop for one customer, from dialing to the final outcome.
_Avoid_: Call (for the whole thing), order, job, task

**Request**:
What the customer wants from the shop, in plain words.
_Avoid_: Order text, prompt

**Order** (mode):
An errand that agrees a pickup purchase and pays for it.

**Ask** (mode):
An errand that only asks the shop a question. No money moves.
_Avoid_: Inquiry, inquire (in customer-facing text)

**Question**:
A decision that the agent hands to the customer during the call.
_Avoid_: Prompt, clarification

**Captions**:
The words of the call, shown to the customer as they are said.
_Avoid_: Chat, messages, log

**Text Dial**:
The way to run an errand by text message, with no app. Dial texts each question and the PayPal link, and the customer texts PAY or PROBLEM at the counter.
_Avoid_: SMS mode, chat

## Money

**Limit**:
The most the customer will pay for an order, tax included. Only the customer can raise it.
_Avoid_: Budget, maximum, max

**Deal**:
The items, total, pickup time, and payee that the agent and the shop agree on the call.
_Avoid_: Quote, offer, cart

**Money gate**:
The fixed rules that accept or block a deal before any money moves.
_Avoid_: Validator, guardrail

**Hold**:
The PayPal authorization of the deal total. The shop is guaranteed the money, but the customer is not yet charged.
_Avoid_: Authorization, pre-auth (in customer-facing text)

**Collect**:
Capture of the hold. The customer collects it at the counter, and the shop hands over the order once PayPal shows the payment. Dial collects it on its own at the collect-by time.
_Avoid_: Charge, settle

**Collect-by time**:
A day after the hold. If the customer has neither collected nor voided the hold by then, Dial collects it, so a customer who does not come still pays the shop.
_Avoid_: Deadline, expiry

**Void**:
Release of the hold when the customer reports a problem before paying.
_Avoid_: Cancel, refund

**Sign-up**:
A shop with no PayPal creates a PayPal account during the call, from a link Dial texts to the shop's number. Dial pays the new account only after PayPal confirms that it can take payments.
_Avoid_: Onboarding, registration

**Pickup key**:
The secret that lets only the customer collect or void the hold. No MCP tool returns it, so an assistant cannot move the money.
_Avoid_: Token, password

**Call receipt**:
The record of a deal: the shop, the deal, and the transcript up to the deal. Its hash goes into the PayPal order, so anyone can check that the record has not changed.
_Avoid_: Proof, log

**Shop Card**:
What Dial keeps about a shop after a deal: the PayPal email from the call, the last deal, and the receipt hash. The next call confirms the email instead of asking for it.
_Avoid_: Profile, merchant record

**Pay in store**:
The outcome when the shop has no PayPal. The customer pays at pickup and Dial moves no money.
_Avoid_: Cash, offline payment

## Demo

**Simulated shop**:
A scripted shop that answers in a fixed way, so the full errand runs without keys.
_Avoid_: Mock, fake shop

**Shop line**:
The page where a person plays the shop and types what the shop says.
_Avoid_: Be the shop, shop view
