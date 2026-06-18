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

function defaultJsonState() {
  return {
    processedEventIds: [],
    webhookEvents: {},
    sessions: {},
    fulfillment: {},
    fulfillmentActions: {},
    payments: {},
    recentRequests: {},
  };
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return defaultJsonState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...defaultJsonState(),
      ...parsed,
      processedEventIds: Array.isArray(parsed.processedEventIds) ? parsed.processedEventIds : [],
      webhookEvents: parsed.webhookEvents || {},
      sessions: parsed.sessions || {},
      fulfillment: parsed.fulfillment || {},
      fulfillmentActions: parsed.fulfillmentActions || {},
      payments: parsed.payments || {},
      recentRequests: parsed.recentRequests || {},
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

function normalizeSessionPatch(sessionId, patch = {}) {
  return {
    stripe_session_id: sessionId,
    payment_intent_id: patch.payment_intent_id ?? null,
    stripe_customer_id: patch.stripe_customer_id ?? null,
    internal_lead_ref: patch.internal_lead_ref ?? null,
    buyer_email_hash: patch.buyer_email_hash ?? null,
    offer_code: patch.offer_code || 'HOS_QUICKSTART_V3',
    stripe_price_id: patch.stripe_price_id || '',
    amount_total: Number.isFinite(patch.amount_total) ? patch.amount_total : (patch.amount_total ?? null),
    currency: String(patch.currency || '').toLowerCase(),
    payment_status: patch.payment_status || 'unpaid',
    fulfillment_status: patch.fulfillment_status || 'pending',
    buyer_tag_status: patch.buyer_tag_status || 'pending',
    declined_tag_removal_status: patch.declined_tag_removal_status || 'pending',
    buyer_delivery_status: patch.buyer_delivery_status || 'pending',
    toolkit_delivery_status: patch.toolkit_delivery_status || 'pending',
    refunded_at: patch.refunded_at ?? null,
    fulfilled_at: patch.fulfilled_at ?? null,
    last_error_code: patch.last_error_code ?? null,
    last_error_message_safe: patch.last_error_message_safe ?? null,
  };
}

function createJsonStore({stateFile}) {
  const ensureState = () => readJsonFile(stateFile);

  const mutate = async mutator => {
    const state = ensureState();
    const result = await mutator(state);
    writeJsonFile(stateFile, state);
    return result;
  };

  return {
    mode: 'json',
    async ready() {},
    health() {
      return {mode: 'json', available: true, fallbackReason: 'DATABASE_URL not configured'};
    },
    async loadState() {
      return ensureState();
    },
    async upsertCheckoutSession(sessionId, patch) {
      return mutate(state => {
        state.sessions = state.sessions || {};
        state.sessions[sessionId] = {
          ...(state.sessions[sessionId] || {}),
          ...normalizeSessionPatch(sessionId, patch),
          updated_at: new Date().toISOString(),
          created_at: state.sessions[sessionId]?.created_at || new Date().toISOString(),
        };
        return state.sessions[sessionId];
      });
    },
    async getCheckoutSession(sessionId) {
      const state = ensureState();
      return state.sessions?.[sessionId] || null;
    },
    async updateFulfillment(sessionId, patch) {
      return mutate(state => {
        state.fulfillment = state.fulfillment || {};
        state.fulfillment[sessionId] = {
          ...(state.fulfillment[sessionId] || {status: 'pending'}),
          ...patch,
          updated_at: new Date().toISOString(),
        };
        return state.fulfillment[sessionId];
      });
    },
    async getFulfillment(sessionId) {
      const state = ensureState();
      return state.fulfillment?.[sessionId] || {status: 'pending'};
    },
    async linkPaymentIntent(sessionId, paymentIntentId) {
      if (!paymentIntentId) return null;
      return mutate(state => {
        state.payments = state.payments || {};
        state.payments[paymentIntentId] = {
          sessionId,
          linked_at: new Date().toISOString(),
        };
        const session = state.sessions?.[sessionId];
        if (session) {
          session.payment_intent_id = paymentIntentId;
          session.updated_at = new Date().toISOString();
        }
        return state.payments[paymentIntentId];
      });
    },
    async getSessionByPaymentIntent(paymentIntentId) {
      const state = ensureState();
      const sessionId = state.payments?.[paymentIntentId]?.sessionId || '';
      if (!sessionId) return null;
      return state.sessions?.[sessionId] || null;
    },
    async recordWebhookEvent({eventId, eventType, livemode}) {
      return mutate(state => {
        state.webhookEvents = state.webhookEvents || {};
        state.processedEventIds = state.processedEventIds || [];
        const existing = state.webhookEvents[eventId];
        if (existing && existing.processing_status === 'processed') {
          return {accepted: false, deduped: true, resumed: false};
        }
        state.webhookEvents[eventId] = {
          stripe_event_id: eventId,
          event_type: eventType || existing?.event_type || '',
          livemode: Boolean(livemode),
          received_at: existing?.received_at || new Date().toISOString(),
          processing_status: 'processing',
          processed_at: null,
          error_code: null,
          error_message_safe: null,
          created_at: existing?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.processedEventIds.push(eventId);
        if (state.processedEventIds.length > 1000) state.processedEventIds = state.processedEventIds.slice(-1000);
        return {accepted: true, deduped: false, resumed: Boolean(existing)};
      });
    },
    async markWebhookEventProcessed(eventId, patch) {
      return mutate(state => {
        state.webhookEvents = state.webhookEvents || {};
        const row = state.webhookEvents[eventId];
        if (!row) return null;
        row.processing_status = patch.processing_status || row.processing_status || 'processed';
        row.processed_at = patch.processed_at || new Date().toISOString();
        row.error_code = patch.error_code ?? null;
        row.error_message_safe = patch.error_message_safe ?? null;
        row.updated_at = new Date().toISOString();
        return row;
      });
    },
    async recordFulfillmentAction(sessionId, actionType, idempotencyKey, patch = {}) {
      return mutate(state => {
        state.fulfillmentActions = state.fulfillmentActions || {};
        state.fulfillmentActions[sessionId] = state.fulfillmentActions[sessionId] || {};
        const existing = state.fulfillmentActions[sessionId][actionType] || {
          stripe_session_id: sessionId,
          action_type: actionType,
          idempotency_key: idempotencyKey,
          status: 'pending',
          attempt_count: 0,
          last_attempt_at: null,
          completed_at: null,
          error_code: null,
          error_message_safe: null,
          created_at: new Date().toISOString(),
        };
        if (existing.status === 'completed' && existing.idempotency_key === idempotencyKey) {
          return existing;
        }
        const now = new Date().toISOString();
        const next = {
          ...existing,
          ...patch,
          idempotency_key: idempotencyKey || existing.idempotency_key,
          attempt_count: (existing.attempt_count || 0) + 1,
          last_attempt_at: now,
          updated_at: now,
        };
        if (next.status === 'completed' && !next.completed_at) next.completed_at = now;
        state.fulfillmentActions[sessionId][actionType] = next;
        return next;
      });
    },
    async getStateSnapshot() {
      return ensureState();
    },
    hashNormalizedEmail,
  };
}

function parseSslMode(value) {
  const mode = String(value || '').toLowerCase();
  if (!mode || mode === 'disable') return false;
  if (mode === 'require' || mode === 'prefer' || mode === 'verify-ca' || mode === 'verify-full') {
    return {rejectUnauthorized: false};
  }
  return {rejectUnauthorized: false};
}

function createPostgresStore({connectionString, sslMode, poolMax, migrationSql, pgModule}) {
  let pg;
  let pool;
  let initialized = false;
  let initError = null;

  const connect = async () => {
    if (initialized) return;
    if (initError) throw initError;
    try {
      pg = pgModule || require('pg');
      pool = new pg.Pool({
        connectionString,
        ssl: parseSslMode(sslMode),
        max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 5,
      });
      await pool.query('SELECT 1');
      if (migrationSql) await pool.query(migrationSql);
      initialized = true;
    } catch (error) {
      initError = error;
      if (pool) {
        try { await pool.end(); } catch {}
      }
      throw error;
    }
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

  const upsertSession = async (client, sessionId, patch) => {
    const row = normalizeSessionPatch(sessionId, patch);
    const result = await client.query(
      `
      INSERT INTO quickstart_checkout_sessions (
        stripe_session_id,
        payment_intent_id,
        stripe_customer_id,
        internal_lead_ref,
        buyer_email_hash,
        offer_code,
        stripe_price_id,
        amount_total,
        currency,
        payment_status,
        fulfillment_status,
        buyer_tag_status,
        declined_tag_removal_status,
        buyer_delivery_status,
        toolkit_delivery_status,
        refunded_at,
        fulfilled_at,
        last_error_code,
        last_error_message_safe
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      ON CONFLICT (stripe_session_id) DO UPDATE SET
        payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, quickstart_checkout_sessions.payment_intent_id),
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, quickstart_checkout_sessions.stripe_customer_id),
        internal_lead_ref = COALESCE(EXCLUDED.internal_lead_ref, quickstart_checkout_sessions.internal_lead_ref),
        buyer_email_hash = COALESCE(EXCLUDED.buyer_email_hash, quickstart_checkout_sessions.buyer_email_hash),
        offer_code = EXCLUDED.offer_code,
        stripe_price_id = EXCLUDED.stripe_price_id,
        amount_total = COALESCE(EXCLUDED.amount_total, quickstart_checkout_sessions.amount_total),
        currency = EXCLUDED.currency,
        payment_status = EXCLUDED.payment_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        buyer_tag_status = EXCLUDED.buyer_tag_status,
        declined_tag_removal_status = EXCLUDED.declined_tag_removal_status,
        buyer_delivery_status = EXCLUDED.buyer_delivery_status,
        toolkit_delivery_status = EXCLUDED.toolkit_delivery_status,
        refunded_at = COALESCE(EXCLUDED.refunded_at, quickstart_checkout_sessions.refunded_at),
        fulfilled_at = COALESCE(EXCLUDED.fulfilled_at, quickstart_checkout_sessions.fulfilled_at),
        last_error_code = EXCLUDED.last_error_code,
        last_error_message_safe = EXCLUDED.last_error_message_safe,
        updated_at = now()
      RETURNING *`,
      [
        row.stripe_session_id,
        row.payment_intent_id,
        row.stripe_customer_id,
        row.internal_lead_ref,
        row.buyer_email_hash,
        row.offer_code,
        row.stripe_price_id,
        row.amount_total,
        row.currency,
        row.payment_status,
        row.fulfillment_status,
        row.buyer_tag_status,
        row.declined_tag_removal_status,
        row.buyer_delivery_status,
        row.toolkit_delivery_status,
        row.refunded_at,
        row.fulfilled_at,
        row.last_error_code,
        row.last_error_message_safe,
      ],
    );
    return result.rows[0];
  };

  return {
    mode: 'postgres',
    async ready() {
      await connect();
    },
    health() {
      return {mode: 'postgres', available: initialized && !initError, fallbackReason: null};
    },
    async loadState() {
      const sessionRows = await pool.query('SELECT * FROM quickstart_checkout_sessions');
      const fulfillmentRows = await pool.query('SELECT * FROM fulfillment_actions');
      const webhookRows = await pool.query('SELECT * FROM stripe_webhook_events');
      const state = defaultJsonState();
      for (const row of sessionRows.rows) {
        state.sessions[row.stripe_session_id] = row;
      }
      for (const row of fulfillmentRows.rows) {
        state.fulfillmentActions[row.stripe_session_id] = state.fulfillmentActions[row.stripe_session_id] || {};
        state.fulfillmentActions[row.stripe_session_id][row.action_type] = row;
      }
      for (const row of webhookRows.rows) {
        state.webhookEvents[row.stripe_event_id] = row;
        if (row.processing_status === 'processed') state.processedEventIds.push(row.stripe_event_id);
      }
      return state;
    },
    async upsertCheckoutSession(sessionId, patch) {
      await connect();
      return withClient(client => upsertSession(client, sessionId, patch));
    },
    async getCheckoutSession(sessionId) {
      await connect();
      const res = await pool.query('SELECT * FROM quickstart_checkout_sessions WHERE stripe_session_id = $1', [sessionId]);
      return res.rows[0] || null;
    },
    async updateFulfillment(sessionId, patch = {}) {
      await connect();
      return withClient(async client => {
        const existing = await client.query('SELECT * FROM quickstart_checkout_sessions WHERE stripe_session_id = $1 FOR UPDATE', [sessionId]);
        if (!existing.rows[0]) {
          const created = await upsertSession(client, sessionId, {
            stripe_session_id: sessionId,
            offer_code: 'HOS_QUICKSTART_V3',
            stripe_price_id: patch.stripe_price_id || '',
            amount_total: patch.amount_total ?? null,
            currency: patch.currency || 'usd',
            payment_status: patch.payment_status || 'unpaid',
            fulfillment_status: patch.status || patch.fulfillment_status || 'pending',
            buyer_tag_status: patch.buyer_tag_status || 'pending',
            declined_tag_removal_status: patch.declined_tag_removal_status || 'pending',
            buyer_delivery_status: patch.buyer_delivery_status || 'pending',
            toolkit_delivery_status: patch.toolkit_delivery_status || 'pending',
            last_error_code: patch.last_error_code ?? null,
            last_error_message_safe: patch.last_error_message_safe ?? null,
            fulfilled_at: patch.fulfilled_at ?? null,
            refunded_at: patch.refunded_at ?? null,
          });
          return created;
        }
        const row = existing.rows[0];
        const next = {
          ...row,
          ...patch,
          updated_at: new Date().toISOString(),
        };
        const result = await client.query(
          `
          UPDATE quickstart_checkout_sessions
          SET
            payment_intent_id = COALESCE($2, payment_intent_id),
            stripe_customer_id = COALESCE($3, stripe_customer_id),
            internal_lead_ref = COALESCE($4, internal_lead_ref),
            buyer_email_hash = COALESCE($5, buyer_email_hash),
            offer_code = COALESCE($6, offer_code),
            stripe_price_id = COALESCE($7, stripe_price_id),
            amount_total = COALESCE($8, amount_total),
            currency = COALESCE($9, currency),
            payment_status = COALESCE($10, payment_status),
            fulfillment_status = COALESCE($11, fulfillment_status),
            buyer_tag_status = COALESCE($12, buyer_tag_status),
            declined_tag_removal_status = COALESCE($13, declined_tag_removal_status),
            buyer_delivery_status = COALESCE($14, buyer_delivery_status),
            toolkit_delivery_status = COALESCE($15, toolkit_delivery_status),
            refunded_at = COALESCE($16, refunded_at),
            fulfilled_at = COALESCE($17, fulfilled_at),
            last_error_code = COALESCE($18, last_error_code),
            last_error_message_safe = COALESCE($19, last_error_message_safe),
            updated_at = now()
          WHERE stripe_session_id = $1
          RETURNING *`,
          [
            sessionId,
            next.payment_intent_id ?? null,
            next.stripe_customer_id ?? null,
            next.internal_lead_ref ?? null,
            next.buyer_email_hash ?? null,
            next.offer_code || 'HOS_QUICKSTART_V3',
            next.stripe_price_id || '',
            next.amount_total ?? null,
            next.currency || '',
            next.payment_status || 'unpaid',
            next.fulfillment_status || 'pending',
            next.buyer_tag_status || 'pending',
            next.declined_tag_removal_status || 'pending',
            next.buyer_delivery_status || 'pending',
            next.toolkit_delivery_status || 'pending',
            next.refunded_at ?? null,
            next.fulfilled_at ?? null,
            next.last_error_code ?? null,
            next.last_error_message_safe ?? null,
          ],
        );
        return result.rows[0];
      });
    },
    async getFulfillment(sessionId) {
      await connect();
      const res = await pool.query(
        'SELECT fulfillment_status AS status, buyer_email_hash, last_error_code AS reason, last_error_message_safe, fulfilled_at, refunded_at, buyer_tag_status, declined_tag_removal_status, buyer_delivery_status, toolkit_delivery_status FROM quickstart_checkout_sessions WHERE stripe_session_id = $1',
        [sessionId],
      );
      if (!res.rows[0]) return {status: 'pending'};
      return res.rows[0];
    },
    async linkPaymentIntent(sessionId, paymentIntentId) {
      if (!paymentIntentId) return null;
      await connect();
      return withClient(async client => {
        await client.query(
          `
          UPDATE quickstart_checkout_sessions
          SET payment_intent_id = COALESCE($2, payment_intent_id),
              updated_at = now()
          WHERE stripe_session_id = $1
          `,
          [sessionId, paymentIntentId],
        );
        const res = await client.query(
          `
          INSERT INTO quickstart_checkout_sessions (
            stripe_session_id,
            payment_intent_id,
            stripe_customer_id,
            internal_lead_ref,
            buyer_email_hash,
            offer_code,
            stripe_price_id,
            amount_total,
            currency,
            payment_status,
            fulfillment_status,
            buyer_tag_status,
            declined_tag_removal_status,
            buyer_delivery_status,
            toolkit_delivery_status
          )
          VALUES ($1,$2,NULL,NULL,NULL,'HOS_QUICKSTART_V3','',NULL,'usd','unpaid','pending','pending','pending','pending','pending')
          ON CONFLICT (stripe_session_id) DO UPDATE SET payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, quickstart_checkout_sessions.payment_intent_id), updated_at = now()
          RETURNING *`,
          [sessionId, paymentIntentId],
        );
        return res.rows[0];
      });
    },
    async getSessionByPaymentIntent(paymentIntentId) {
      await connect();
      const res = await pool.query('SELECT * FROM quickstart_checkout_sessions WHERE payment_intent_id = $1', [paymentIntentId]);
      return res.rows[0] || null;
    },
    async recordWebhookEvent({eventId, eventType, livemode}) {
      await connect();
      return withClient(async client => {
        const existing = await client.query(
          'SELECT stripe_event_id, processing_status, received_at, created_at, event_type FROM stripe_webhook_events WHERE stripe_event_id = $1 FOR UPDATE',
          [eventId],
        );
        if (existing.rows[0]?.processing_status === 'processed') {
          return {accepted: false, deduped: true, resumed: false};
        }
        if (existing.rows[0]) {
          await client.query(
            `
            UPDATE stripe_webhook_events
            SET event_type = COALESCE($2, event_type),
                livemode = $3,
                processing_status = 'processing',
                processed_at = NULL,
                error_code = NULL,
                error_message_safe = NULL,
                updated_at = now()
            WHERE stripe_event_id = $1
            `,
            [eventId, eventType || existing.rows[0].event_type || '', Boolean(livemode)],
          );
          return {accepted: true, deduped: false, resumed: true};
        }
        const res = await client.query(
          `
          INSERT INTO stripe_webhook_events (
            stripe_event_id,
            event_type,
            livemode,
            processing_status
          )
          VALUES ($1,$2,$3,'processing')
          RETURNING stripe_event_id`,
          [eventId, eventType, Boolean(livemode)],
        );
        if (!res.rows[0]) return {accepted: false, deduped: true, resumed: false};
        return {accepted: true, deduped: false, resumed: false};
      });
    },
    async markWebhookEventProcessed(eventId, patch = {}) {
      await connect();
      await pool.query(
        `
        UPDATE stripe_webhook_events
        SET processing_status = $2,
            processed_at = COALESCE($3, processed_at),
            error_code = $4,
            error_message_safe = $5,
            updated_at = now()
        WHERE stripe_event_id = $1
        `,
        [
          eventId,
          patch.processing_status || 'processed',
          patch.processed_at || new Date().toISOString(),
          patch.error_code ?? null,
          patch.error_message_safe ?? null,
        ],
      );
    },
    async recordFulfillmentAction(sessionId, actionType, idempotencyKey, patch = {}) {
      await connect();
      return withClient(async client => {
        const existing = await client.query(
          'SELECT * FROM fulfillment_actions WHERE stripe_session_id = $1 AND action_type = $2 FOR UPDATE',
          [sessionId, actionType],
        );
        if (existing.rows[0]?.status === 'completed' && existing.rows[0]?.idempotency_key === idempotencyKey) {
          return existing.rows[0];
        }
        await client.query(
          `
          INSERT INTO fulfillment_actions (
            stripe_session_id,
            action_type,
            idempotency_key,
            status,
            attempt_count,
            last_attempt_at,
            completed_at,
            error_code,
            error_message_safe
          )
          VALUES ($1,$2,$3,$4,1,now(),$5,$6,$7)
          ON CONFLICT (stripe_session_id, action_type) DO UPDATE SET
            idempotency_key = CASE WHEN fulfillment_actions.status = 'completed' AND fulfillment_actions.idempotency_key = EXCLUDED.idempotency_key THEN fulfillment_actions.idempotency_key ELSE EXCLUDED.idempotency_key END,
            status = CASE WHEN fulfillment_actions.status = 'completed' AND fulfillment_actions.idempotency_key = EXCLUDED.idempotency_key THEN fulfillment_actions.status ELSE EXCLUDED.status END,
            attempt_count = CASE WHEN fulfillment_actions.status = 'completed' AND fulfillment_actions.idempotency_key = EXCLUDED.idempotency_key THEN fulfillment_actions.attempt_count ELSE fulfillment_actions.attempt_count + 1 END,
            last_attempt_at = now(),
            completed_at = COALESCE(EXCLUDED.completed_at, fulfillment_actions.completed_at),
            error_code = EXCLUDED.error_code,
            error_message_safe = EXCLUDED.error_message_safe,
            updated_at = now()
          `,
          [
            sessionId,
            actionType,
            idempotencyKey,
            patch.status || 'pending',
            patch.completed_at ?? null,
            patch.error_code ?? null,
            patch.error_message_safe ?? null,
          ],
        );
        const res = await client.query(
          'SELECT * FROM fulfillment_actions WHERE stripe_session_id = $1 AND action_type = $2',
          [sessionId, actionType],
        );
        return res.rows[0] || null;
      });
    },
    async getStateSnapshot() {
      await connect();
      const [sessions, fulfillments, webhooks, actions] = await Promise.all([
        pool.query('SELECT * FROM quickstart_checkout_sessions'),
        pool.query('SELECT * FROM quickstart_checkout_sessions'),
        pool.query('SELECT * FROM stripe_webhook_events'),
        pool.query('SELECT * FROM fulfillment_actions'),
      ]);
      const state = defaultJsonState();
      for (const row of sessions.rows) {
        state.sessions[row.stripe_session_id] = row;
        state.fulfillment[row.stripe_session_id] = {
          status: row.fulfillment_status,
          reason: row.last_error_code || row.last_error_message_safe || '',
          buyer_email_hash: row.buyer_email_hash || '',
          payment_intent: row.payment_intent_id || '',
          updated_at: row.updated_at,
          refunded_at: row.refunded_at,
          fulfilled_at: row.fulfilled_at,
          buyer_tag_status: row.buyer_tag_status,
          declined_tag_removal_status: row.declined_tag_removal_status,
          buyer_delivery_status: row.buyer_delivery_status,
          toolkit_delivery_status: row.toolkit_delivery_status,
        };
      }
      for (const row of webhooks.rows) {
        state.webhookEvents[row.stripe_event_id] = row;
        if (row.processing_status === 'processed') state.processedEventIds.push(row.stripe_event_id);
      }
      for (const row of actions.rows) {
        state.fulfillmentActions[row.stripe_session_id] = state.fulfillmentActions[row.stripe_session_id] || {};
        state.fulfillmentActions[row.stripe_session_id][row.action_type] = row;
      }
      return state;
    },
    hashNormalizedEmail,
    buildDbError,
  };
}

async function createQuickstartStorage(options = {}) {
  const stateFile = options.stateFile || path.join(process.cwd(), 'quickstart-stripe-state.json');
  const migrationSql = options.migrationSql || (options.migrationFile && fs.existsSync(options.migrationFile)
    ? fs.readFileSync(options.migrationFile, 'utf8')
    : '');
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
    migrationSql,
    pgModule: options.pgModule,
  });
}

module.exports = {
  createQuickstartStorage,
  createJsonStore,
  createPostgresStore,
  defaultJsonState,
  normalizeSessionPatch,
  hashNormalizedEmail,
  safeErrorMessage,
};
