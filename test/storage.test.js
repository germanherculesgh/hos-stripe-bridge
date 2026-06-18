const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {createQuickstartStorage, hashNormalizedEmail} = require('../storage');

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
  DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function createFakePgModule() {
  const db = {
    schemaMigrations: new Map(),
    webhookEvents: new Map(),
    sessions: new Map(),
    fulfillmentActions: new Map(),
  };

  function clone(row) {
    return row ? JSON.parse(JSON.stringify(row)) : row;
  }

  function upsertSession(params) {
    const [sessionId, paymentIntentId, stripeCustomerId, leadRef, buyerEmailHash, offerCode, stripePriceId, amountTotal, currency, paymentStatus, fulfillmentStatus, buyerTagStatus, declinedTagRemovalStatus, buyerDeliveryStatus, toolkitDeliveryStatus, refundedAt, fulfilledAt, lastErrorCode, lastErrorMessageSafe] = params;
    const existing = db.sessions.get(sessionId) || {};
    const row = {
      stripe_session_id: sessionId,
      payment_intent_id: paymentIntentId ?? existing.payment_intent_id ?? null,
      stripe_customer_id: stripeCustomerId ?? existing.stripe_customer_id ?? null,
      internal_lead_ref: leadRef ?? existing.internal_lead_ref ?? null,
      buyer_email_hash: buyerEmailHash ?? existing.buyer_email_hash ?? null,
      offer_code: offerCode ?? existing.offer_code ?? '',
      stripe_price_id: stripePriceId ?? existing.stripe_price_id ?? '',
      amount_total: amountTotal ?? existing.amount_total ?? null,
      currency: currency ?? existing.currency ?? '',
      payment_status: paymentStatus ?? existing.payment_status ?? 'unpaid',
      fulfillment_status: fulfillmentStatus ?? existing.fulfillment_status ?? 'pending',
      buyer_tag_status: buyerTagStatus ?? existing.buyer_tag_status ?? 'pending',
      declined_tag_removal_status: declinedTagRemovalStatus ?? existing.declined_tag_removal_status ?? 'pending',
      buyer_delivery_status: buyerDeliveryStatus ?? existing.buyer_delivery_status ?? 'pending',
      toolkit_delivery_status: toolkitDeliveryStatus ?? existing.toolkit_delivery_status ?? 'pending',
      refunded_at: refundedAt ?? existing.refunded_at ?? null,
      fulfilled_at: fulfilledAt ?? existing.fulfilled_at ?? null,
      last_error_code: lastErrorCode ?? existing.last_error_code ?? null,
      last_error_message_safe: lastErrorMessageSafe ?? existing.last_error_message_safe ?? null,
      updated_at: new Date().toISOString(),
      created_at: existing.created_at || new Date().toISOString(),
    };
    db.sessions.set(sessionId, row);
    return row;
  }

  function upsertAction(params) {
    const [sessionId, actionType, idempotencyKey, status, completedAt, errorCode, errorMessageSafe] = params;
    const key = `${sessionId}:${actionType}`;
    const existing = db.fulfillmentActions.get(key);
    if (existing && existing.status === 'completed' && existing.idempotency_key === idempotencyKey) {
      return existing;
    }
    const row = {
      id: (existing?.id || db.fulfillmentActions.size + 1),
      stripe_session_id: sessionId,
      action_type: actionType,
      idempotency_key: idempotencyKey,
      status: status || existing?.status || 'pending',
      attempt_count: (existing?.attempt_count || 0) + 1,
      last_attempt_at: new Date().toISOString(),
      completed_at: completedAt ?? existing?.completed_at ?? null,
      error_code: errorCode ?? null,
      error_message_safe: errorMessageSafe ?? null,
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.fulfillmentActions.set(key, row);
    return row;
  }

  function route(sql, params = []) {
    const text = String(sql).trim();
    if (text === 'SELECT 1') return {rows: [{'?column?': 1}]};
    if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return {rows: []};
    if (text.startsWith('SELECT checksum FROM schema_migrations')) {
      const row = db.schemaMigrations.get(params[0]);
      return {rows: row ? [{checksum: row.checksum}] : []};
    }
    if (text.startsWith('INSERT INTO schema_migrations')) {
      db.schemaMigrations.set(params[0], {checksum: params[1], applied_at: new Date().toISOString()});
      return {rows: []};
    }
    if (text.startsWith('SELECT * FROM quickstart_checkout_sessions WHERE stripe_session_id = $1 FOR UPDATE')) {
      const row = db.sessions.get(params[0]);
      return {rows: row ? [clone(row)] : []};
    }
    if (text.startsWith('UPDATE quickstart_checkout_sessions')) {
      const sessionId = params[0];
      const existing = db.sessions.get(sessionId) || {};
      return {rows: [clone(upsertSession([
        sessionId,
        params[1],
        params[2],
        params[3],
        params[4],
        params[5],
        params[6],
        params[7],
        params[8],
        params[9],
        params[10],
        params[11],
        params[12],
        params[13],
        params[14],
        params[15],
        params[16],
        params[17],
        params[18],
      ]))]};
    }
    if (text.startsWith('INSERT INTO quickstart_checkout_sessions')) {
      return {rows: [clone(upsertSession(params))]};
    }
    if (text.startsWith('SELECT * FROM quickstart_checkout_sessions WHERE stripe_session_id = $1')) {
      const row = db.sessions.get(params[0]);
      return {rows: row ? [clone(row)] : []};
    }
    if (text.startsWith('SELECT fulfillment_status AS status')) {
      const row = db.sessions.get(params[0]);
      return {rows: row ? [{
        status: row.fulfillment_status,
        buyer_email_hash: row.buyer_email_hash,
        reason: row.last_error_code,
        last_error_message_safe: row.last_error_message_safe,
        fulfilled_at: row.fulfilled_at,
        refunded_at: row.refunded_at,
        buyer_tag_status: row.buyer_tag_status,
        declined_tag_removal_status: row.declined_tag_removal_status,
        buyer_delivery_status: row.buyer_delivery_status,
        toolkit_delivery_status: row.toolkit_delivery_status,
      }] : []};
    }
    if (text.startsWith('SELECT * FROM quickstart_checkout_sessions WHERE payment_intent_id = $1')) {
      const row = [...db.sessions.values()].find(v => v.payment_intent_id === params[0]);
      return {rows: row ? [clone(row)] : []};
    }
    if (text.startsWith('SELECT stripe_event_id, processing_status')) {
      const row = db.webhookEvents.get(params[0]);
      return {rows: row ? [clone(row)] : []};
    }
    if (text.startsWith('UPDATE stripe_webhook_events')) {
      const row = db.webhookEvents.get(params[0]);
      if (row) {
        row.processing_status = params[1];
        row.processed_at = params[2] || row.processed_at || new Date().toISOString();
        row.error_code = params[3] ?? null;
        row.error_message_safe = params[4] ?? null;
        row.updated_at = new Date().toISOString();
      }
      return {rows: row ? [clone(row)] : []};
    }
    if (text.startsWith('INSERT INTO stripe_webhook_events')) {
      const existing = db.webhookEvents.get(params[0]);
      if (existing) return {rows: []};
      const row = {
        stripe_event_id: params[0],
        event_type: params[1],
        livemode: Boolean(params[2]),
        received_at: new Date().toISOString(),
        processing_status: 'processing',
        processed_at: null,
        error_code: null,
        error_message_safe: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      db.webhookEvents.set(params[0], row);
      return {rows: [{stripe_event_id: params[0]}]};
    }
    if (text.startsWith('SELECT * FROM fulfillment_actions WHERE stripe_session_id = $1 AND action_type = $2 FOR UPDATE')) {
      const row = db.fulfillmentActions.get(`${params[0]}:${params[1]}`);
      return {rows: row ? [clone(row)] : []};
    }
    if (text.startsWith('INSERT INTO fulfillment_actions')) {
      return {rows: [clone(upsertAction(params))]};
    }
    if (text.startsWith('SELECT * FROM fulfillment_actions WHERE stripe_session_id = $1 AND action_type = $2')) {
      const row = db.fulfillmentActions.get(`${params[0]}:${params[1]}`);
      return {rows: row ? [clone(row)] : []};
    }
    if (text.startsWith('SELECT * FROM quickstart_checkout_sessions')) {
      return {rows: [...db.sessions.values()].map(clone)};
    }
    if (text.startsWith('SELECT * FROM fulfillment_actions')) {
      return {rows: [...db.fulfillmentActions.values()].map(clone)};
    }
    if (text.startsWith('SELECT * FROM stripe_webhook_events')) {
      return {rows: [...db.webhookEvents.values()].map(clone)};
    }
    if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) return {rows: []};
    throw new Error(`unhandled SQL: ${text}`);
  }

  class FakeClient {
    async query(sql, params) {
      return route(sql, params);
    }
    release() {}
  }

  class Pool {
    constructor() {}
    async query(sql, params) {
      return route(sql, params);
    }
    async connect() {
      return new FakeClient();
    }
    async end() {}
  }

  return {Pool, __db: db};
}

test('json fallback persists state and hashes email for durable logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hos-json-store-'));
  const stateFile = path.join(root, 'state.json');
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'development';

  const storage = await createQuickstartStorage({stateFile});
  await storage.upsertCheckoutSession('cs_json_1', {
    offer_code: 'HOS_QUICKSTART_V3',
    stripe_price_id: 'price_test',
    amount_total: 1700,
    currency: 'usd',
    payment_status: 'paid',
    fulfillment_status: 'pending',
    buyer_email_hash: hashNormalizedEmail('buyer@example.com'),
  });
  await storage.recordWebhookEvent({eventId: 'evt_json_1', eventType: 'checkout.session.completed', livemode: false});
  await storage.updateFulfillment('cs_json_1', {status: 'fulfilled', fulfilled_at: '2026-06-17T00:00:00.000Z'});

  const snapshot = await storage.loadState();
  assert.equal(snapshot.sessions.cs_json_1.stripe_price_id, 'price_test');
  assert.equal(snapshot.fulfillment.cs_json_1.status, 'fulfilled');
  assert.equal(snapshot.webhookEvents.evt_json_1.processing_status, 'processing');
  assert.equal(fs.existsSync(stateFile), true);
  restoreEnv();
});

test('postgres store dedupes webhook events, retries partial failure, and keeps completed actions idempotent', async () => {
  const fakePg = createFakePgModule();
  process.env.DATABASE_URL = 'postgres://example/test';
  process.env.NODE_ENV = 'development';

  const storage = await createQuickstartStorage({pgModule: fakePg});
  await storage.ready();

  const first = await storage.recordWebhookEvent({eventId: 'evt_pg_1', eventType: 'checkout.session.completed', livemode: false});
  assert.equal(first.accepted, true);
  await storage.markWebhookEventProcessed('evt_pg_1', {processing_status: 'processed'});
  const second = await storage.recordWebhookEvent({eventId: 'evt_pg_1', eventType: 'checkout.session.completed', livemode: false});
  assert.equal(second.deduped, true);

  await storage.upsertCheckoutSession('cs_pg_1', {
    offer_code: 'HOS_QUICKSTART_V3',
    stripe_price_id: 'price_test',
    amount_total: 1700,
    currency: 'usd',
    payment_status: 'paid',
    fulfillment_status: 'partial_failure',
    buyer_tag_status: 'completed',
  });
  await storage.recordFulfillmentAction('cs_pg_1', 'buyer_tag_added', 'evt_pg_1', {status: 'completed', completed_at: new Date().toISOString()});
  const repeated = await storage.recordFulfillmentAction('cs_pg_1', 'buyer_tag_added', 'evt_pg_1', {status: 'completed', completed_at: new Date().toISOString()});
  assert.equal(repeated.status, 'completed');
  assert.equal(repeated.attempt_count, 1);

  const status = await storage.getFulfillment('cs_pg_1');
  assert.equal(status.status, 'partial_failure');
  assert.equal('buyer_email_hash' in status, true);
  restoreEnv();
});

test('production without DATABASE_URL fails closed', async () => {
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'production';
  await assert.rejects(() => createQuickstartStorage({stateFile: path.join(os.tmpdir(), 'nope.json')}), /DATABASE_URL is required in production/);
  restoreEnv();
});
