# Provider Adapters

## PaymentProvider

- Stripe
- Creates checkout sessions
- Verifies webhook signatures
- Provides Stripe session fetches for webhook reconciliation

## CRMProvider

- eStage
- Staging-safe adapter currently records intent and returns skipped when sync is disabled

## EmailProvider

- GetResponse
- Finds or creates contacts
- Applies buyer, lead, and refund suppression behavior
- Disabled by default in staging

## FulfillmentProvider

- Render bridge
- Sends test-only access payloads when enabled
- Disabled by default in staging

## AnalyticsProvider

- Existing `dataLayer`
- Meta Pixel
- GTM

## Rule

Provider-specific behavior stays behind adapter boundaries so Genesis can replace one component at a time later.
