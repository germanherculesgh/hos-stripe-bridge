# HOS Stripe Bridge

Secure backend for Hercules OS QuickStart Pack purchases.

## Purpose

Receives Stripe `checkout.session.completed` webhook events, verifies the Stripe signature, filters to the Hercules OS QuickStart Pack Payment Link, then creates/updates the buyer in GetResponse and applies the buyer tag.

## Endpoints

- `GET /health`
- `POST /webhooks/stripe/hos-quickstart`

## Required environment variables

```bash
GETRESPONSE_API_KEY=...
STRIPE_WEBHOOK_SECRET=...
GETRESPONSE_BASE_URL=https://api.getresponse.com/v3
HOS_GETRESPONSE_CAMPAIGN_ID=f12ji
HOS_BUYER_TAG_ID=4P1aD
STRIPE_PAYMENT_LINK_ID=plink_1TcIvYDfPgr5wAVlitvX7U2C
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
