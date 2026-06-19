# Database Schema

## Tables

- `contacts`
- `orders`
- `payments`
- `payment_events`
- `refunds`
- `fulfillment_events`
- `provider_links`
- `audit_logs`

## Key Constraints

- `contacts.email` is unique
- `payment_events.provider_event_id` is unique
- `fulfillment_events.idempotency_key` is unique
- `provider_links.provider + external_id` is unique

## State Fields

- Order statuses: `created`, `pending`, `paid`, `payment_failed`, `fulfilled`, `refunded`, `partially_refunded`, `canceled`
- Fulfillment statuses: `pending`, `processing`, `completed`, `failed`, `reversed`

## Data Rules

- No card data is stored.
- No raw secrets are stored.
- Event payloads are redacted.
- External provider IDs are stored through provider links when possible.
