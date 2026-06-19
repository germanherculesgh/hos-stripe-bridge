# HOS Stripe Bridge

Staging bridge for Hercules OS QuickStart purchases.

## Purpose

Receives Stripe checkout and refund webhook events, verifies the Stripe signature, creates test-mode Checkout Sessions for the Hercules OS QuickStart Toolkit, and writes a provider-neutral commerce truth layer in PostgreSQL.

The current architecture keeps the customer-facing hub in eStage, keeps payment authority in Stripe, isolates email sync behind GetResponse, and leaves fulfillment behind a Render-side adapter so the pieces can later be swapped into native Genesis services.

## Endpoints

- `GET /health`
- `POST /checkout/quickstart`
- `GET /checkout/session-status`
- `POST /webhooks/stripe/hos-quickstart`

## Required environment variables

```bash
PAYMENT_PROVIDER=stripe
CRM_PROVIDER=estage
EMAIL_PROVIDER=getresponse
FULFILLMENT_PROVIDER=render
CHECKOUT_MODE=external
ENABLE_ESTATE_SYNC=false
ENABLE_GETRESPONSE_SYNC=false
ENABLE_REAL_FULFILLMENT=false
STRIPE_MODE=test
GETRESPONSE_API_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_SECRET_KEY=...
STRIPE_QUICKSTART_PRICE_ID=...
STRIPE_ENVIRONMENT=test
GETRESPONSE_BASE_URL=https://api.getresponse.com/v3
HOS_GETRESPONSE_CAMPAIGN_ID=f12ji
HOS_BUYER_TAG_ID=4P1aD
HOS_DECLINED_TAG_ID=...
STRIPE_PAYMENT_LINK_ID=plink_1TcIvYDfPgr5wAVlitvX7U2C
QUICKSTART_SUCCESS_URL=https://herculeswellness.club/start-thank-you-buyer?session_id={CHECKOUT_SESSION_ID}
QUICKSTART_CANCEL_URL=https://herculeswellness.club/start-thank-you-declined?checkout=cancelled
QUICKSTART_ACCESS_URL=https://<internal-toolkit-delivery-endpoint>
PORT=19001 # Render sets PORT automatically
```

## Truth Layer

The staging database now stores:

- contacts
- orders
- payments
- payment events
- refunds
- fulfillment events
- provider links
- audit logs

Webhook dedupe is enforced with a unique `provider_event_id`, and fulfillment dedupe is enforced with a unique `idempotency_key`.

## Render deploy notes

Use this folder as the service root.

- Runtime: Node
- Build command: blank / none
- Start command: `npm start`
- Health check path: `/health`

The canonical fulfillment trigger is `checkout.session.completed`.

After deploy, update Stripe Workbench/Event Destination URL to:

`https://<render-service-url>/webhooks/stripe/hos-quickstart`

Then copy the new Stripe endpoint signing secret into Render as `STRIPE_WEBHOOK_SECRET`.

For test-mode checkout validation, call:

`POST /checkout/quickstart`

To inspect a completed session safely, call:

`GET /checkout/session-status?session_id=cs_test_...`
