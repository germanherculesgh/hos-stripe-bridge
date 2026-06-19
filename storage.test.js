const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {createPostgresStore, createQuickstartStorage, hashNormalizedEmail} = require('../storage');

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('json fallback stores contacts, orders, payments, events, refunds, and audit logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hos-truth-store-'));
  const stateFile = path.join(root, 'state.json');
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'development';

  const storage = await createQuickstartStorage({stateFile});
  const contact = await storage.upsertContact({
    email: 'buyer@example.com',
    first_name: 'Buyer',
    last_name: 'Name',
    phone: null,
    status: 'active',
  });
  const order = await storage.upsertOrder({
    contact_id: contact.id,
    product_reference: 'price_test',
    provider: 'stripe',
    provider_checkout_session_id: 'cs_test_1',
    provider_order_id: 'pi_test_1',
    currency: 'usd',
    amount: 1700,
    order_status: 'paid',
  });
  const payment = await storage.upsertPayment({
    order_id: order.id,
    provider: 'stripe',
    provider_customer_id: 'cus_test_1',
    payment_intent_id: 'pi_test_1',
    charge_id: 'ch_test_1',
    amount: 1700,
    currency: 'usd',
    payment_status: 'paid',
    test_mode: true,
  });
  const paymentEvent = await storage.recordPaymentEvent({
    provider_event_id: 'evt_test_1',
    event_type: 'checkout.session.completed',
    processing_status: 'processing',
    received_at: new Date().toISOString(),
    attempt_count: 1,
    last_error: null,
    payload_ref: 'stripe:evt_test_1',
    safe_metadata: {session_id: 'cs_test_1'},
    livemode: false,
  });
  const refund = await storage.recordRefund({
    payment_id: payment.id,
    provider_refund_id: 're_test_1',
    amount: 1700,
    currency: 'usd',
    refund_status: 'succeeded',
    reason: 'requested_by_customer',
  });
  const fulfillment = await storage.recordFulfillmentEvent({
    order_id: order.id,
    fulfillment_type: 'buyer_delivery',
    provider: 'render',
    status: 'completed',
    idempotency_key: 'stripe:cs_test_1:buyer_delivery',
    last_error: null,
    completed_at: new Date().toISOString(),
  });
  const link = await storage.upsertProviderLink({
    provider: 'stripe',
    external_id: 'cs_test_1',
    entity_type: 'order',
    entity_id: order.id,
    metadata: {session_id: 'cs_test_1'},
  });
  const audit = await storage.appendAuditLog({
    event_type: 'purchase_recorded',
    entity_type: 'order',
    entity_id: order.id,
    action: 'upsert',
    result: 'ok',
    source: 'stripe',
    redacted_error_context: {payment_intent: 'pi_test_1'},
  });

  assert.equal(contact.email, 'buyer@example.com');
  assert.equal(order.order_status, 'paid');
  assert.equal(payment.payment_status, 'paid');
  assert.equal(paymentEvent.provider_event_id, 'evt_test_1');
  assert.equal(refund.provider_refund_id, 're_test_1');
  assert.equal(fulfillment.idempotency_key, 'stripe:cs_test_1:buyer_delivery');
  assert.equal(link.external_id, 'cs_test_1');
  assert.equal(audit.action, 'upsert');

  const snapshot = await storage.snapshot();
  assert.equal(snapshot.contacts['buyer@example.com'].email, 'buyer@example.com');
  assert.equal(snapshot.orders['cs_test_1'].provider_checkout_session_id, 'cs_test_1');
  assert.equal(snapshot.payments['pi_test_1'].payment_intent_id, 'pi_test_1');
  assert.equal(snapshot.paymentEvents.evt_test_1.event_type, 'checkout.session.completed');
  assert.equal(snapshot.refunds.re_test_1.refund_status, 'succeeded');
  assert.equal(snapshot.fulfillmentEvents['stripe:cs_test_1:buyer_delivery'].status, 'completed');
  assert.equal(snapshot.providerLinks['stripe:cs_test_1'].entity_id, order.id);
  assert.equal(snapshot.auditLogs[0].result, 'ok');
  assert.equal(hashNormalizedEmail('Buyer@Example.com'), hashNormalizedEmail('buyer@example.com'));

  restoreEnv();
});

test('postgres store retries after a temporary connection failure', async () => {
  let selectOneFailuresRemaining = 1;
  const fakePg = {
    Pool: class {
      constructor() {
        this.query = this.query.bind(this);
      }
      async query(sql, params) {
        const text = String(sql).trim();
        if (text === 'SELECT 1') {
          if (selectOneFailuresRemaining > 0) {
            selectOneFailuresRemaining -= 1;
            throw new Error('temporary connection failure');
          }
          return {rows: []};
        }
        if (text.includes('INSERT INTO contacts')) {
          return {
            rows: [{
              id: '11111111-1111-1111-1111-111111111111',
              email: params[1],
              first_name: params[2] || '',
              last_name: params[3] || '',
              phone: params[4],
              status: params[5],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }],
          };
        }
        return {rows: []};
      }
      async connect() {
        return {query: this.query, release() {}};
      }
      async end() {}
    },
  };

  const store = createPostgresStore({
    connectionString: 'postgres://example/test',
    pgModule: fakePg,
  });

  await assert.rejects(() => store.upsertContact({
    email: 'buyer@example.com',
    first_name: 'Buyer',
    last_name: 'Name',
    phone: null,
    status: 'active',
  }), /temporary connection failure/);

  const contact = await store.upsertContact({
    email: 'buyer@example.com',
    first_name: 'Buyer',
    last_name: 'Name',
    phone: null,
    status: 'active',
  });

  assert.equal(contact.email, 'buyer@example.com');
  assert.equal(store.health().available, true);
  assert.equal(store.health().fallbackReason, null);
});
