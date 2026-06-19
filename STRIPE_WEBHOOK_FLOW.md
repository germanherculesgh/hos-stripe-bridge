# Stripe Webhook Flow

## Endpoint

- `POST /webhooks/stripe/hos-quickstart`

## Processing Order

1. Read raw request body.
2. Verify `Stripe-Signature`.
3. Reject invalid signatures before JSON parsing.
4. Record the Stripe event ID in `payment_events`.
5. Skip duplicate event IDs.
6. Process the event inside the bridge transaction flow.
7. Mark success or failure with a safe redacted error summary.

## Supported Events

- `checkout.session.completed`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded`

## Canonical Choice

`checkout.session.completed` is the canonical fulfillment event because it represents the completed checkout session and avoids double fulfillment when `payment_intent.succeeded` also arrives.

## Safety Rules

- Duplicate fulfillment is prevented by the idempotency key.
- Refund replay is prevented by Stripe event dedupe.
- Unsupported subscription assumptions are documented but not implemented.
