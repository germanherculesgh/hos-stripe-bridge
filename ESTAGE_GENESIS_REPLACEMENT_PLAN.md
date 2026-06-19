# eStage / Genesis Replacement Plan

## Current Safe Position

- Keep eStage as the customer-facing hub.
- Keep Stripe as the payment authority.
- Keep GetResponse for email automation until equivalent Genesis behavior is proven.
- Keep Render/Postgres as the bridge truth layer for staging.

## Future Replacement Map

- Stripe Payment Link -> Genesis order form
- Render webhook logic -> Genesis Dedicated Cloud, if proven
- PostgreSQL truth layer -> Genesis database, if proven
- GetResponse -> Genesis automation only after buyer/non-buyer/refund flows pass staging tests

## Migration Rule

Replace one provider at a time, behind feature flags, and only after the staging bridge proves the behavior with no duplicate fulfillment and no real-customer side effects.
