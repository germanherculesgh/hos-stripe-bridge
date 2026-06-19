const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function safeText(value, maxLen = 180) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function safeErrorMessage(value, maxLen = 300) {
  return safeText(value, maxLen);
}

function hashNormalizedEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function defaultJsonState() {
  return {
    contacts: {},
    orders: {},
    payments: {},
    paymentEvents: {},
    refunds: {},
    fulfillmentEvents: {},
    providerLinks: {},
    auditLogs: [],
    legacy: {
      webhookEvents: {},
      fulfillmentActions: {},
      sessions: {},
      paymentsByIntent: {},
    },
  };
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return defaultJsonState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...defaultJsonState(),
      ...parsed,
      contacts: parsed.contacts || {},
      orders: parsed.orders || {},
      payments: parsed.payments || {},
      paymentEvents: parsed.paymentEvents || {},
      refunds: parsed.refunds || {},
      fulfillmentEvents: parsed.fulfillmentEvents || {},
      providerLinks: parsed.providerLinks || {},
      auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
      legacy: {
        ...defaultJsonState().legacy,
        ...(parsed.legacy || {}),
      },
    };
  } catch {
    return defaultJsonState();
  }
}

function writeJsonFile(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function buildDbError(error, code = 'db_error') {
  return {
    ok: false,
    error,
    code,
    safeMessage: safeErrorMessage(error?.message || error || code),
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatus(value, fallback) {
  const next = String(value || fallback || '').trim().toLowerCase();
  return next || fallback;
}

function jsonUpsertByKey(collection, key, value) {
  collection[key] = {
    ...(collection[key] || {}),
    ...value,
    updated_at: nowIso(),
    created_at: collection[key]?.created_at || nowIso(),
  };
  return collection[key];
}

function createJsonStore({stateFile}) {
  const ensureState = () => readJsonFile(stateFile);

  const mutate = async mutator => {
    const state = ensureState();
    const result = await mutator(state);
    writeJsonFile(stateFile, state);
    return result;
  };

  const upsertContact = async contact => mutate(state => {
    const email = normalizeEmail(contact.email);
    if (!email) throw new Error('email required');
    const row = jsonUpsertByKey(state.contacts, email, {
      id: state.contacts[email]?.id || uuid(),
      email,
      first_name: safeText(contact.first_name || contact.firstName || '', 120),
      last_name: safeText(contact.last_name || contact.lastName || '', 120),
      phone: contact.phone ? safeText(contact.phone, 40) : null,
      status: normalizeStatus(contact.status, state.contacts[email]?.status || 'active'),
    });
    return row;
  });

  const upsertOrder = async order => mutate(state => {
    if (!order.contact_id) throw new Error('contact_id required');
    const key = order.provider_checkout_session_id || order.provider_order_id || order.provider_reference || uuid();
    const row = jsonUpsertByKey(state.orders, key, {
      id: state.orders[key]?.id || uuid(),
      contact_id: order.contact_id,
      product_reference: safeText(order.product_reference || '', 120),
      provider: safeText(order.provider || '', 40),
      provider_checkout_session_id: order.provider_checkout_session_id || null,
      provider_order_id: order.provider_order_id || null,
      currency: String(order.currency || '').toLowerCase(),
      amount: Number.isFinite(order.amount) ? order.amount : Number(order.amount || 0),
      order_status: normalizeStatus(order.order_status, state.orders[key]?.order_status || 'created'),
    });
    return row;
  });

  const upsertPayment = async payment => mutate(state => {
    if (!payment.order_id) throw new Error('order_id required');
    const key = payment.payment_intent_id || payment.provider_charge_id || uuid();
    const row = jsonUpsertByKey(state.payments, key, {
      id: state.payments[key]?.id || uuid(),
      order_id: payment.order_id,
      provider: safeText(payment.provider || '', 40),
      provider_customer_id: payment.provider_customer_id || null,
      payment_intent_id: payment.payment_intent_id || null,
      charge_id: payment.charge_id || null,
      amount: Number.isFinite(payment.amount) ? payment.amount : Number(payment.amount || 0),
      currency: String(payment.currency || '').toLowerCase(),
      payment_status: normalizeStatus(payment.payment_status, state.payments[key]?.payment_status || 'pending'),
      test_mode: Boolean(payment.test_mode),
    });
    return row;
  });

  const recordPaymentEvent = async event => mutate(state => {
    const eventId = safeText(event.provider_event_id || '', 120);
    if (!eventId) throw new Error('provider_event_id required');
    const existing = state.paymentEvents[eventId];
    if (existing && existing.processing_status === 'processed') return existing;
    const row = {
      id: existing?.id || uuid(),
      provider_event_id: eventId,
      event_type: safeText(event.event_type || '', 120),
      processing_status: normalizeStatus(event.processing_status, existing?.processing_status || 'processing'),
      received_at: existing?.received_at || event.received_at || nowIso(),
      processed_at: event.processed_at ?? existing?.processed_at ?? null,
      attempt_count: (existing?.attempt_count || 0) + 1,
      last_error: event.last_error ?? existing?.last_error ?? null,
      payload_ref: event.payload_ref || existing?.payload_ref || null,
      safe_metadata: event.safe_metadata || existing?.safe_metadata || null,
      livemode: Boolean(event.livemode),
      updated_at: nowIso(),
      created_at: existing?.created_at || nowIso(),
    };
    state.paymentEvents[eventId] = row;
    return row;
  });

  const markPaymentEventProcessed = async (providerEventId, patch = {}) => mutate(state => {
    const row = state.paymentEvents[providerEventId];
    if (!row) return null;
    row.processing_status = normalizeStatus(patch.processing_status, row.processing_status || 'processed');
    row.processed_at = patch.processed_at || nowIso();
    row.last_error = patch.last_error ?? null;
    row.safe_metadata = patch.safe_metadata ?? row.safe_metadata ?? null;
    row.updated_at = nowIso();
    return row;
  });

  const recordRefund = async refund => mutate(state => {
    const key = safeText(refund.provider_refund_id || '', 120);
    if (!key) throw new Error('provider_refund_id required');
    const row = jsonUpsertByKey(state.refunds, key, {
      id: state.refunds[key]?.id || uuid(),
      payment_id: refund.payment_id,
      provider_refund_id: key,
      amount: Number.isFinite(refund.amount) ? refund.amount : Number(refund.amount || 0),
      currency: String(refund.currency || '').toLowerCase(),
      refund_status: normalizeStatus(refund.refund_status, state.refunds[key]?.refund_status || 'pending'),
      reason: refund.reason ?? null,
    });
    return row;
  });

  const recordFulfillmentEvent = async event => mutate(state => {
    const key = event.idempotency_key || uuid();
    const row = jsonUpsertByKey(state.fulfillmentEvents, key, {
      id: state.fulfillmentEvents[key]?.id || uuid(),
      order_id: event.order_id,
      fulfillment_type: safeText(event.fulfillment_type || '', 80),
      provider: safeText(event.provider || '', 40),
      status: normalizeStatus(event.status, state.fulfillmentEvents[key]?.status || 'pending'),
      idempotency_key: key,
      attempt_count: (state.fulfillmentEvents[key]?.attempt_count || 0) + 1,
      last_error: event.last_error ?? null,
      completed_at: event.completed_at ?? state.fulfillmentEvents[key]?.completed_at ?? null,
    });
    return row;
  });

  const appendAuditLog = async entry => mutate(state => {
    const row = {
      id: uuid(),
      event_type: safeText(entry.event_type || '', 120),
      entity_type: safeText(entry.entity_type || '', 80),
      entity_id: safeText(entry.entity_id || '', 120),
      action: safeText(entry.action || '', 80),
      result: safeText(entry.result || '', 80),
      source: safeText(entry.source || '', 80),
      timestamp: entry.timestamp || nowIso(),
      redacted_error_context: entry.redacted_error_context || null,
    };
    state.auditLogs.push(row);
    return row;
  });

  const upsertProviderLink = async link => mutate(state => {
    const provider = safeText(link.provider || '', 40);
    const externalId = safeText(link.external_id || '', 180);
    if (!provider || !externalId) throw new Error('provider and external_id required');
    const key = `${provider}:${externalId}`;
    state.providerLinks[key] = {
      ...(state.providerLinks[key] || {}),
      id: state.providerLinks[key]?.id || uuid(),
      provider,
      external_id: externalId,
      entity_type: safeText(link.entity_type || '', 80),
      entity_id: link.entity_id || null,
      metadata: link.metadata || null,
      updated_at: nowIso(),
      created_at: state.providerLinks[key]?.created_at || nowIso(),
    };
    return state.providerLinks[key];
  });

  const getContactByEmail = async email => {
    const state = ensureState();
    return state.contacts?.[normalizeEmail(email)] || null;
  };

  const getOrderByExternalRef = async ({provider, providerCheckoutSessionId, providerOrderId}) => {
    const state = ensureState();
    const keys = [
      providerCheckoutSessionId ? `${provider}:${providerCheckoutSessionId}` : null,
      providerOrderId ? `${provider}:${providerOrderId}` : null,
    ].filter(Boolean);
    for (const key of keys) {
      const row = state.orders[key];
      if (row) return row;
    }
    return null;
  };

  const getPaymentByIntent = async paymentIntentId => {
    const state = ensureState();
    return state.payments?.[paymentIntentId] || null;
  };

  const getOrderById = async orderId => {
    const state = ensureState();
    return Object.values(state.orders).find(row => row.id === orderId) || null;
  };

  const getPaymentById = async paymentId => {
    const state = ensureState();
    return Object.values(state.payments).find(row => row.id === paymentId) || null;
  };

  const snapshot = async () => ensureState();

  return {
    mode: 'json',
    async ready() {},
    health() {
      return {mode: 'json', available: true, fallbackReason: 'DATABASE_URL not configured'};
    },
    loadState: snapshot,
    snapshot,
    upsertContact,
    getContactByEmail,
    upsertOrder,
    getOrderById,
    getOrderByExternalRef,
    upsertPayment,
    getPaymentById,
    getPaymentByIntent,
    recordPaymentEvent,
    markPaymentEventProcessed,
    recordRefund,
    recordFulfillmentEvent,
    appendAuditLog,
    upsertProviderLink,
    hashNormalizedEmail,
    buildDbError,
    recordLegacySession: async () => null,
  };
}

function parseSslMode(value) {
  const mode = String(value || '').toLowerCase();
  if (!mode || mode === 'disable') return false;
  return {rejectUnauthorized: false};
}

function rowToJson(row) {
  if (!row) return null;
  const value = {};
  for (const [key, item] of Object.entries(row)) {
    value[key] = item;
  }
  return value;
}

function createPostgresStore({connectionString, sslMode, poolMax, pgModule}) {
  let pg;
  let pool;
  let initialized = false;
  let lastConnectError = null;
  let connectPromise = null;

  const connect = async () => {
    if (initialized) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      try {
        pg = pgModule || require('pg');
        pool = new pg.Pool({
          connectionString,
          ssl: parseSslMode(sslMode),
          max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 5,
        });
        await pool.query('SELECT 1');
        initialized = true;
        lastConnectError = null;
      } catch (error) {
        lastConnectError = error;
        initialized = false;
        if (pool) {
          try { await pool.end(); } catch {}
        }
        pool = null;
        throw error;
      } finally {
        connectPromise = null;
      }
    })();
    return connectPromise;
  };

  const withClient = async fn => {
    await connect();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };

  const upsertContact = async contact => withClient(async client => {
    const email = normalizeEmail(contact.email);
    if (!email) throw new Error('email required');
    const res = await client.query(
      `
      INSERT INTO contacts (id, email, first_name, last_name, phone, status)
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
        last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
        phone = COALESCE(EXCLUDED.phone, contacts.phone),
        status = COALESCE(EXCLUDED.status, contacts.status),
        updated_at = now()
      RETURNING *`,
      [
        contact.id || null,
        email,
        safeText(contact.first_name || contact.firstName || '', 120) || '',
        safeText(contact.last_name || contact.lastName || '', 120) || '',
        contact.phone ? safeText(contact.phone, 40) : null,
        normalizeStatus(contact.status, 'active'),
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const getContactByEmail = async email => {
    await connect();
    const res = await pool.query('SELECT * FROM contacts WHERE email = $1', [normalizeEmail(email)]);
    return rowToJson(res.rows[0]);
  };

  const upsertOrder = async order => withClient(async client => {
    if (!order.contact_id) throw new Error('contact_id required');
    const key = order.provider_checkout_session_id || order.provider_order_id;
    const existing = key
      ? await client.query(
          `
          SELECT *
          FROM orders
          WHERE provider = $1 AND (provider_checkout_session_id = $2 OR provider_order_id = $3)
          FOR UPDATE`,
          [safeText(order.provider || '', 40), order.provider_checkout_session_id || null, order.provider_order_id || null],
        )
      : {rows: []};
    if (existing.rows[0]) {
      const res = await client.query(
        `
        UPDATE orders
        SET product_reference = COALESCE($2, product_reference),
            provider = COALESCE($3, provider),
            provider_checkout_session_id = COALESCE($4, provider_checkout_session_id),
            provider_order_id = COALESCE($5, provider_order_id),
            currency = COALESCE($6, currency),
            amount = COALESCE($7, amount),
            order_status = COALESCE($8, order_status),
            updated_at = now()
        WHERE id = $1
        RETURNING *`,
        [
          existing.rows[0].id,
          order.product_reference ? safeText(order.product_reference, 120) : null,
          order.provider ? safeText(order.provider, 40) : null,
          order.provider_checkout_session_id || null,
          order.provider_order_id || null,
          order.currency ? String(order.currency).toLowerCase() : null,
          Number.isFinite(order.amount) ? order.amount : Number(order.amount || 0),
          order.order_status ? normalizeStatus(order.order_status, existing.rows[0].order_status) : null,
        ],
      );
      return rowToJson(res.rows[0]);
    }
    const res = await client.query(
      `
      INSERT INTO orders (
        id, contact_id, product_reference, provider, provider_checkout_session_id,
        provider_order_id, currency, amount, order_status
      )
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        order.id || null,
        order.contact_id,
        safeText(order.product_reference || '', 120),
        safeText(order.provider || '', 40),
        order.provider_checkout_session_id || null,
        order.provider_order_id || null,
        String(order.currency || '').toLowerCase(),
        Number.isFinite(order.amount) ? order.amount : Number(order.amount || 0),
        normalizeStatus(order.order_status, 'created'),
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const getOrderByExternalRef = async ({provider, providerCheckoutSessionId, providerOrderId}) => {
    await connect();
    const res = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE provider = $1
        AND ($2::text IS NULL OR provider_checkout_session_id = $2)
        AND ($3::text IS NULL OR provider_order_id = $3)
      ORDER BY updated_at DESC
      LIMIT 1`,
      [safeText(provider || '', 40), providerCheckoutSessionId || null, providerOrderId || null],
    );
    return rowToJson(res.rows[0]);
  };

  const getOrderById = async orderId => {
    await connect();
    const res = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    return rowToJson(res.rows[0]);
  };

  const upsertPayment = async payment => withClient(async client => {
    if (!payment.order_id) throw new Error('order_id required');
    const key = payment.payment_intent_id || payment.provider_charge_id;
    const existing = key
      ? await client.query(
          `
          SELECT *
          FROM payments
          WHERE provider = $1 AND (payment_intent_id = $2 OR charge_id = $3)
          FOR UPDATE`,
          [safeText(payment.provider || '', 40), payment.payment_intent_id || null, payment.charge_id || null],
        )
      : {rows: []};
    if (existing.rows[0]) {
      const res = await client.query(
        `
        UPDATE payments
        SET provider_customer_id = COALESCE($2, provider_customer_id),
            payment_intent_id = COALESCE($3, payment_intent_id),
            charge_id = COALESCE($4, charge_id),
            amount = COALESCE($5, amount),
            currency = COALESCE($6, currency),
            payment_status = COALESCE($7, payment_status),
            test_mode = COALESCE($8, test_mode),
            updated_at = now()
        WHERE id = $1
        RETURNING *`,
        [
          existing.rows[0].id,
          payment.provider_customer_id || null,
          payment.payment_intent_id || null,
          payment.charge_id || null,
          Number.isFinite(payment.amount) ? payment.amount : Number(payment.amount || 0),
          payment.currency ? String(payment.currency).toLowerCase() : null,
          payment.payment_status ? normalizeStatus(payment.payment_status, existing.rows[0].payment_status) : null,
          typeof payment.test_mode === 'boolean' ? payment.test_mode : null,
        ],
      );
      return rowToJson(res.rows[0]);
    }
    const res = await client.query(
      `
      INSERT INTO payments (
        id, order_id, provider, provider_customer_id, payment_intent_id,
        charge_id, amount, currency, payment_status, test_mode
      )
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        payment.id || null,
        payment.order_id,
        safeText(payment.provider || '', 40),
        payment.provider_customer_id || null,
        payment.payment_intent_id || null,
        payment.charge_id || null,
        Number.isFinite(payment.amount) ? payment.amount : Number(payment.amount || 0),
        String(payment.currency || '').toLowerCase(),
        normalizeStatus(payment.payment_status, 'pending'),
        Boolean(payment.test_mode),
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const getPaymentByIntent = async paymentIntentId => {
    await connect();
    const res = await pool.query('SELECT * FROM payments WHERE payment_intent_id = $1', [paymentIntentId]);
    return rowToJson(res.rows[0]);
  };

  const getPaymentById = async paymentId => {
    await connect();
    const res = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    return rowToJson(res.rows[0]);
  };

  const recordPaymentEvent = async event => withClient(async client => {
    const eventId = safeText(event.provider_event_id || '', 120);
    if (!eventId) throw new Error('provider_event_id required');
    const existing = await client.query(
      'SELECT * FROM payment_events WHERE provider_event_id = $1 FOR UPDATE',
      [eventId],
    );
    if (existing.rows[0]?.processing_status === 'processed') return rowToJson(existing.rows[0]);
    if (existing.rows[0]) {
      const res = await client.query(
        `
        UPDATE payment_events
        SET event_type = COALESCE($2, event_type),
            processing_status = COALESCE($3, processing_status),
            received_at = COALESCE($4, received_at),
            processed_at = COALESCE($5, processed_at),
            attempt_count = attempt_count + 1,
            last_error = COALESCE($6, last_error),
            payload_ref = COALESCE($7, payload_ref),
            safe_metadata = COALESCE($8, safe_metadata),
            livemode = COALESCE($9, livemode),
            updated_at = now()
        WHERE provider_event_id = $1
        RETURNING *`,
        [
          eventId,
          event.event_type || existing.rows[0].event_type || '',
          event.processing_status || existing.rows[0].processing_status || 'processing',
          event.received_at || existing.rows[0].received_at,
          event.processed_at ?? existing.rows[0].processed_at,
          event.last_error ?? existing.rows[0].last_error,
          event.payload_ref ?? existing.rows[0].payload_ref,
          event.safe_metadata ?? existing.rows[0].safe_metadata,
          typeof event.livemode === 'boolean' ? event.livemode : existing.rows[0].livemode,
        ],
      );
      return rowToJson(res.rows[0]);
    }
    const res = await client.query(
      `
      INSERT INTO payment_events (
        id, provider_event_id, event_type, processing_status, received_at,
        processed_at, attempt_count, last_error, payload_ref, safe_metadata, livemode
      )
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, 1, $7, $8, $9, $10)
      RETURNING *`,
      [
        event.id || null,
        eventId,
        safeText(event.event_type || '', 120),
        normalizeStatus(event.processing_status, 'processing'),
        event.received_at || nowIso(),
        event.processed_at ?? null,
        event.last_error ?? null,
        event.payload_ref ?? null,
        event.safe_metadata ?? null,
        Boolean(event.livemode),
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const markPaymentEventProcessed = async (providerEventId, patch = {}) => withClient(async client => {
    const res = await client.query(
      `
      UPDATE payment_events
      SET processing_status = COALESCE($2, processing_status),
          processed_at = COALESCE($3, processed_at),
          last_error = $4,
          safe_metadata = COALESCE($5, safe_metadata),
          updated_at = now()
      WHERE provider_event_id = $1
      RETURNING *`,
      [
        providerEventId,
        patch.processing_status || 'processed',
        patch.processed_at || nowIso(),
        patch.last_error ?? null,
        patch.safe_metadata ?? null,
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const recordRefund = async refund => withClient(async client => {
    const res = await client.query(
      `
      INSERT INTO refunds (
        id, payment_id, provider_refund_id, amount, currency, refund_status, reason
      )
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
      ON CONFLICT (provider_refund_id) DO UPDATE SET
        payment_id = COALESCE(EXCLUDED.payment_id, refunds.payment_id),
        amount = COALESCE(EXCLUDED.amount, refunds.amount),
        currency = COALESCE(EXCLUDED.currency, refunds.currency),
        refund_status = COALESCE(EXCLUDED.refund_status, refunds.refund_status),
        reason = COALESCE(EXCLUDED.reason, refunds.reason),
        updated_at = now()
      RETURNING *`,
      [
        refund.id || null,
        refund.payment_id,
        safeText(refund.provider_refund_id || '', 120),
        Number.isFinite(refund.amount) ? refund.amount : Number(refund.amount || 0),
        String(refund.currency || '').toLowerCase(),
        normalizeStatus(refund.refund_status, 'pending'),
        refund.reason ?? null,
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const recordFulfillmentEvent = async event => withClient(async client => {
    const res = await client.query(
      `
      INSERT INTO fulfillment_events (
        id, order_id, fulfillment_type, provider, status, idempotency_key,
        attempt_count, last_error, completed_at
      )
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, 1, $7, $8)
      ON CONFLICT (idempotency_key) DO UPDATE SET
        order_id = COALESCE(EXCLUDED.order_id, fulfillment_events.order_id),
        fulfillment_type = COALESCE(EXCLUDED.fulfillment_type, fulfillment_events.fulfillment_type),
        provider = COALESCE(EXCLUDED.provider, fulfillment_events.provider),
        status = CASE
          WHEN fulfillment_events.status = 'completed' AND fulfillment_events.idempotency_key = EXCLUDED.idempotency_key
            THEN fulfillment_events.status
          ELSE EXCLUDED.status
        END,
        attempt_count = CASE
          WHEN fulfillment_events.status = 'completed' AND fulfillment_events.idempotency_key = EXCLUDED.idempotency_key
            THEN fulfillment_events.attempt_count
          ELSE fulfillment_events.attempt_count + 1
        END,
        last_error = EXCLUDED.last_error,
        completed_at = COALESCE(EXCLUDED.completed_at, fulfillment_events.completed_at),
        updated_at = now()
      RETURNING *`,
      [
        event.id || null,
        event.order_id,
        safeText(event.fulfillment_type || '', 80),
        safeText(event.provider || '', 40),
        normalizeStatus(event.status, 'pending'),
        safeText(event.idempotency_key || '', 180),
        event.last_error ?? null,
        event.completed_at ?? null,
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const appendAuditLog = async entry => withClient(async client => {
    const res = await client.query(
      `
      INSERT INTO audit_logs (
        id, event_type, entity_type, entity_id, action, result, source, timestamp, redacted_error_context
      )
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $9)
      RETURNING *`,
      [
        entry.id || null,
        safeText(entry.event_type || '', 120),
        safeText(entry.entity_type || '', 80),
        safeText(entry.entity_id || '', 120),
        safeText(entry.action || '', 80),
        safeText(entry.result || '', 80),
        safeText(entry.source || '', 80),
        entry.timestamp || null,
        entry.redacted_error_context || null,
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const upsertProviderLink = async link => withClient(async client => {
    const res = await client.query(
      `
      INSERT INTO provider_links (
        id, provider, external_id, entity_type, entity_id, metadata
      )
      VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)
      ON CONFLICT (provider, external_id) DO UPDATE SET
        entity_type = COALESCE(EXCLUDED.entity_type, provider_links.entity_type),
        entity_id = COALESCE(EXCLUDED.entity_id, provider_links.entity_id),
        metadata = COALESCE(EXCLUDED.metadata, provider_links.metadata),
        updated_at = now()
      RETURNING *`,
      [
        link.id || null,
        safeText(link.provider || '', 40),
        safeText(link.external_id || '', 180),
        safeText(link.entity_type || '', 80),
        link.entity_id || null,
        link.metadata ?? null,
      ],
    );
    return rowToJson(res.rows[0]);
  });

  const health = () => ({
    mode: 'postgres',
    available: initialized,
    fallbackReason: lastConnectError ? safeErrorMessage(lastConnectError.message || lastConnectError, 120) : null,
  });

  const snapshot = async () => {
    await connect();
    const [contacts, orders, payments, paymentEvents, refunds, fulfillmentEvents, providerLinks, auditLogs] = await Promise.all([
      pool.query('SELECT * FROM contacts'),
      pool.query('SELECT * FROM orders'),
      pool.query('SELECT * FROM payments'),
      pool.query('SELECT * FROM payment_events'),
      pool.query('SELECT * FROM refunds'),
      pool.query('SELECT * FROM fulfillment_events'),
      pool.query('SELECT * FROM provider_links'),
      pool.query('SELECT * FROM audit_logs'),
    ]);
    return {
      contacts: Object.fromEntries(contacts.rows.map(row => [row.email, rowToJson(row)])),
      orders: Object.fromEntries(orders.rows.map(row => [row.id, rowToJson(row)])),
      payments: Object.fromEntries(payments.rows.map(row => [row.id, rowToJson(row)])),
      paymentEvents: Object.fromEntries(paymentEvents.rows.map(row => [row.provider_event_id, rowToJson(row)])),
      refunds: Object.fromEntries(refunds.rows.map(row => [row.provider_refund_id, rowToJson(row)])),
      fulfillmentEvents: Object.fromEntries(fulfillmentEvents.rows.map(row => [row.idempotency_key, rowToJson(row)])),
      providerLinks: Object.fromEntries(providerLinks.rows.map(row => [`${row.provider}:${row.external_id}`, rowToJson(row)])),
      auditLogs: auditLogs.rows.map(rowToJson),
    };
  };

  return {
    mode: 'postgres',
    async ready() {
      await connect();
    },
    health,
    loadState: snapshot,
    snapshot,
    upsertContact,
    getContactByEmail,
    upsertOrder,
    getOrderById,
    getOrderByExternalRef,
    upsertPayment,
    getPaymentById,
    getPaymentByIntent,
    recordPaymentEvent,
    markPaymentEventProcessed,
    recordRefund,
    recordFulfillmentEvent,
    appendAuditLog,
    upsertProviderLink,
    hashNormalizedEmail,
    buildDbError,
    recordLegacySession: async () => null,
  };
}

async function createQuickstartStorage(options = {}) {
  const stateFile = options.stateFile || path.join(process.cwd(), 'quickstart-stripe-state.json');
  const databaseUrl = process.env.DATABASE_URL || '';
  const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();

  if (!databaseUrl) {
    if (nodeEnv === 'production') {
      throw new Error('DATABASE_URL is required in production');
    }
    return createJsonStore({stateFile});
  }

  return createPostgresStore({
    connectionString: databaseUrl,
    sslMode: process.env.DATABASE_SSL_MODE || '',
    poolMax: Number(process.env.DATABASE_POOL_MAX || 5),
    pgModule: options.pgModule,
  });
}

module.exports = {
  createQuickstartStorage,
  createJsonStore,
  createPostgresStore,
  defaultJsonState,
  hashNormalizedEmail,
  safeErrorMessage,
  safeText,
};
