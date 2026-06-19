# Staging Architecture

This service is the staging commerce bridge for Hercules OS QuickStart.

## Current Role Split

- eStage: customer-facing hub, pages, community, course surface
- Stripe: payment authority and test-mode checkout/session events
- PostgreSQL: durable commerce truth layer
- Render: fulfillment adapter and host for the bridge
- GetResponse: email automation and suppression layer

## Feature Flags

- `PAYMENT_PROVIDER=stripe`
- `CRM_PROVIDER=estage`
- `EMAIL_PROVIDER=getresponse`
- `FULFILLMENT_PROVIDER=render`
- `CHECKOUT_MODE=external`
- `ENABLE_ESTATE_SYNC=false`
- `ENABLE_GETRESPONSE_SYNC=false`
- `ENABLE_REAL_FULFILLMENT=false`
- `STRIPE_MODE=test`

## Canonical Trigger

`checkout.session.completed` is the canonical fulfillment trigger.
`payment_intent.succeeded` updates payment state but does not create a second fulfillment action.

## Isolation Notes

- Production checkout remains external.
- Staging side effects are disabled by default.
- Duplicate Stripe events are deduped by `payment_events.provider_event_id`.
- Duplicate fulfillment actions are deduped by `fulfillment_events.idempotency_key`.
