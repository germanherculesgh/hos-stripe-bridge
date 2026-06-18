# HOS Stripe Bridge

Secure backend for Hercules OS QuickStart Pack purchases.

## Purpose

Receives Stripe checkout and refund webhook events, verifies the Stripe signature, creates test-mode Checkout Sessions for the Hercules OS QuickStart Toolkit, and creates/updates the buyer in GetResponse.

## Endpoints

- `GET /health`
- `POST /checkout/quickstart`
- `GET /checkout/session-status`
- `POST /webhooks/stripe/hos-quickstart`

## Required environment variables

```bash
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

## Render deploy notes

Use this folder as the service root.

- Runtime: Node
- Build command: blank / none
- Start command: `npm start`
- Health check path: `/health`

After deploy, update Stripe Workbench/Event Destination URL to:

`https://<render-service-url>/webhooks/stripe/hos-quickstart`

Then copy the new Stripe endpoint signing secret into Render as `STRIPE_WEBHOOK_SECRET`.

For test-mode checkout validation, call:

`POST /checkout/quickstart`

To inspect a completed session safely, call:

`GET /checkout/session-status?session_id=cs_test_...`
