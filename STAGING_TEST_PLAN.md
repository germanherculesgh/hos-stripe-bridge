# Staging Test Plan

## Required Checks

1. Valid Stripe signature
2. Invalid Stripe signature
3. Successful test payment
4. Failed test payment
5. Duplicate delivery of one Stripe event
6. Two Stripe events for the same payment
7. Refund event
8. Replayed refund event
9. Transaction rollback on forced failure
10. Fulfillment retry without duplicate fulfillment
11. Missing eStage integration
12. Missing GetResponse integration
13. Provider timeout
14. Health endpoint
15. Database reconnection after temporary failure

## Local Verification Now

- Tests cover health, checkout creation, webhook signature rejection, dedupe, payment failure, refund handling, and disabled side effects.
- Real Render database verification still needs the staging `DATABASE_URL`.

## Success Criteria

- One payment creates one canonical payment record.
- Duplicate events do not create duplicate orders or fulfillment rows.
- Invalid signatures do not change database state.
- Refunds update the existing order state.
- No real customer is contacted.
