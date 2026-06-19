const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {createQuickstartStorage, hashNormalizedEmail, safeText} = require('./storage');
const {loadFeatureFlags} = require('./lib/feature-flags');
const {assertOrderTransition, assertFulfillmentTransition} = require('./lib/state-machine');
const {
  createStripeProvider,
  createCRMProvider,
  createEmailProvider,
  createFulfillmentProvider,
  createAnalyticsProvider,
} = require('./lib/providers');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 19001);
const LOG_DIR = path.join(process.env.HOS_BRIDGE_LOG_DIR || path.join(__dirname, 'logs'));
const STATE_DIR = path.join(process.env.HOS_BRIDGE_STATE_DIR || path.join(__dirname, 'state'));
const STATE_FILE = path.join(STATE_DIR, 'quickstart-truth-state.json');
const QUICKSTART_OFFER_CODE = 'HOS_QUICKSTART_V3';
const QUICKSTART_AMOUNT_CENTS = 1700;
const QUICKSTART_CURRENCY = 'usd';
const DEFAULT_PRODUCT_REFERENCE = process.env.STRIPE_QUICKSTART_PRICE_ID || QUICKSTART_OFFER_CODE;
const ALLOWED_ORIGINS = new Set([
  'https://herculeswellness.club',
  'https://www.herculeswellness.club',
  'https://my-web-1696084750836.estage.com',
]);
const RETRYABLE_FULFILLMENT_ERRORS = new Set([
  'getresponse_failed',
  'toolkit_delivery_failed',
  'stripe_session_lookup_failed',
  'handler_error',
]);

const flags = loadFeatureFlags(process.env);
const storagePromise = createQuickstartStorage({stateFile: STATE_FILE});
const stripe = createStripeProvider({env: process.env, fetch: global.fetch.bind(global), logger: log});
const crm = createCRMProvider({env: process.env, flags, storage: null});
const email = createEmailProvider({env: process.env, flags, fetch: global.fetch.bind(global), storage: null});
const fulfillment = createFulfillmentProvider({flags, fetch: global.fetch.bind(global), env: process.env});
const analytics = createAnalyticsProvider({logger: log});

let storageMode = 'initializing';
storagePromise.then(storage => {
  storageMode = storage.mode;
  console.log(`Quickstart storage backend: ${storage.mode}`);
}).catch(err => {
  storageMode = 'unavailable';
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.error('Quickstart storage initialization failed in production');
    console.error(err?.stack || String(err));
    process.exit(1);
  } else {
    console.warn('Quickstart storage initialization failed; local fallback was not available');
  }
});

fs.mkdirSync(LOG_DIR, {recursive: true});
fs.mkdirSync(STATE_DIR, {recursive: true});

function log(kind, data) {
  const payload = JSON.stringify({at: new Date().toISOString(), ...data});
  fs.appendFileSync(path.join(LOG_DIR, `${kind}.jsonl`), payload + '\n');
  if (kind === 'errors' || kind === 'support-alerts') {
    console.log(payload);
  }
}

function safeJson(value, maxLen = 400) {
  try {
    return JSON.stringify(value).slice(0, maxLen);
  } catch {
    return '"[unserializable]"';
  }
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://herculeswellness.club';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, stripe-signature, x-request-id',
    'vary': 'Origin',
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {'content-type': type, ...extraHeaders});
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function ensureOpaqueLeadRef(value) {
  const ref = safeText(value, 120);
  if (!ref) return {ok: false, error: 'lead_ref required'};
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref)) return {ok: false, error: 'lead_ref must be opaque'};
  if (!/^[a-zA-Z0-9._:-]+$/.test(ref)) return {ok: false, error: 'lead_ref contains invalid characters'};
  return {ok: true, value: ref};
}

function validateCheckoutBody(input) {
  const allowed = new Set(['lead_ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);
  for (const key of Object.keys(input || {})) {
    if (!allowed.has(key)) return {ok: false, error: `unknown field: ${key}`};
  }
  const leadRefResult = ensureOpaqueLeadRef(input.lead_ref || `lr_${crypto.randomBytes(12).toString('hex')}`);
  if (!leadRefResult.ok) return leadRefResult;
  return {
    ok: true,
    value: {
      lead_ref: leadRefResult.value,
      utm_source: safeText(input.utm_source, 80),
      utm_medium: safeText(input.utm_medium, 80),
      utm_campaign: safeText(input.utm_campaign, 80),
      utm_content: safeText(input.utm_content, 80),
      utm_term: safeText(input.utm_term, 80),
    },
  };
}

function normalizeLead(input) {
  const firstName = String(input.firstName || input.first_name || input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const phone = String(input.phone || '').trim();
  return {email, name: firstName || 'Hercules OS Lead', phone, source: String(input.source || 'hercules_os_start').slice(0, 80)};
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function healthEnvStatus() {
  const databaseUrlPresent = Boolean(process.env.DATABASE_URL || '');
  return {
    DATABASE_URL: databaseUrlPresent ? 'present' : 'absent',
    GETRESPONSE_API_KEY: process.env.GETRESPONSE_API_KEY ? 'present' : 'absent',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? 'present' : 'absent',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? 'present' : 'absent',
    STRIPE_QUICKSTART_PRICE_ID: process.env.STRIPE_QUICKSTART_PRICE_ID ? 'present' : 'absent',
    QUICKSTART_ACCESS_URL: process.env.QUICKSTART_ACCESS_URL ? 'present' : 'absent',
    STRIPE_MODE: flags.stripeMode,
    PAYMENT_PROVIDER: flags.paymentProvider,
    CRM_PROVIDER: flags.crmProvider,
    EMAIL_PROVIDER: flags.emailProvider,
    FULFILLMENT_PROVIDER: flags.fulfillmentProvider,
    CHECKOUT_MODE: flags.checkoutMode,
    ENABLE_ESTATE_SYNC: flags.enableEstateSync ? 'true' : 'false',
    ENABLE_GETRESPONSE_SYNC: flags.enableGetResponseSync ? 'true' : 'false',
    ENABLE_REAL_FULFILLMENT: flags.enableRealFulfillment ? 'true' : 'false',
  };
}

async function getStorage() {
  return storagePromise;
}

async function withStorage(fn) {
  const storage = await getStorage();
  return fn(storage);
}

async function buildProviders() {
  const storage = await getStorage();
  return {
    stripe,
    crm: createCRMProvider({env: process.env, flags, storage}),
    email: createEmailProvider({env: process.env, flags, fetch: global.fetch.bind(global), storage}),
    fulfillment: createFulfillmentProvider({flags, fetch: global.fetch.bind(global), env: process.env}),
    analytics,
    storage,
  };
}

async function getHealthSnapshot() {
  let storageHealth = {mode: storageMode, available: false, fallbackReason: 'initializing'};
  try {
    const storage = await getStorage();
    storageHealth = storage.health();
  } catch (error) {
    storageHealth = {mode: storageMode, available: false, fallbackReason: safeText(error.message || 'storage unavailable', 120)};
  }
  return storageHealth;
}

async function createOrLoadContact(storage, emailAddress, name, phone = null) {
  const existing = await storage.getContactByEmail(emailAddress);
  if (existing) return existing;
  return storage.upsertContact({
    email: emailAddress,
    first_name: name,
    last_name: '',
    phone,
    status: 'active',
  });
}

async function createPurchaseTruth(storage, {session, event, canonicalEventId}) {
  const buyerEmail = session.customer_details?.email || session.customer_email || event?.data?.object?.customer_details?.email || event?.data?.object?.customer_email || '';
  const buyerName = session.customer_details?.name || event?.data?.object?.customer_details?.name || 'Hercules OS Buyer';
  if (!validEmail(buyerEmail)) throw new Error('missing_buyer_email');

  const contact = await createOrLoadContact(storage, buyerEmail, buyerName);
  await storage.upsertProviderLink({
    provider: 'stripe',
    external_id: session.id,
    entity_type: 'order',
    entity_id: null,
    metadata: {checkout_session_id: session.id},
  });

  const order = await storage.upsertOrder({
    contact_id: contact.id,
    product_reference: session.metadata?.price_id || session.metadata?.offer_code || DEFAULT_PRODUCT_REFERENCE,
    provider: 'stripe',
    provider_checkout_session_id: session.id,
    provider_order_id: session.payment_intent?.id || session.payment_intent || null,
    currency: String(session.currency || 'usd').toLowerCase(),
    amount: Number(session.amount_total || QUICKSTART_AMOUNT_CENTS),
    order_status: assertOrderTransition('created', session.payment_status === 'paid' ? 'paid' : 'pending'),
  });

  const payment = await storage.upsertPayment({
    order_id: order.id,
    provider: 'stripe',
    provider_customer_id: session.customer || session.customer_details?.email || null,
    payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    charge_id: null,
    amount: Number(session.amount_total || QUICKSTART_AMOUNT_CENTS),
    currency: String(session.currency || 'usd').toLowerCase(),
    payment_status: session.payment_status === 'paid' ? 'paid' : 'pending',
    test_mode: !Boolean(session.livemode),
  });

  await storage.upsertProviderLink({
    provider: 'stripe',
    external_id: payment.payment_intent_id || session.id,
    entity_type: 'payment',
    entity_id: payment.id,
    metadata: {session_id: session.id},
  });
  await storage.upsertProviderLink({
    provider: 'stripe',
    external_id: session.id,
    entity_type: 'order',
    entity_id: order.id,
    metadata: {checkout_session_id: session.id, payment_id: payment.id},
  });

  await storage.appendAuditLog({
    event_type: 'purchase_recorded',
    entity_type: 'order',
    entity_id: order.id,
    action: 'upsert',
    result: 'ok',
    source: 'stripe',
    redacted_error_context: {event_id: canonicalEventId, payment_status: session.payment_status},
  });

  return {contact, order, payment};
}

async function applyBuyerSync(storage, emailAddress, buyerName) {
  const crmProvider = createCRMProvider({env: process.env, flags, storage});
  const emailProvider = createEmailProvider({env: process.env, flags, fetch: global.fetch.bind(global), storage});

  const crmResult = await crmProvider.syncBuyerContact({email: emailAddress, name: buyerName});
  const emailResult = await emailProvider.syncBuyerContact({email: emailAddress, name: buyerName});

  return {crmResult, emailResult};
}

async function applyRefundSync(storage, emailAddress, buyerName) {
  const crmProvider = createCRMProvider({env: process.env, flags, storage});
  const emailProvider = createEmailProvider({env: process.env, flags, fetch: global.fetch.bind(global), storage});
  const crmResult = await crmProvider.syncRefundState({email: emailAddress, name: buyerName});
  const emailResult = await emailProvider.syncRefundState({email: emailAddress, name: buyerName});
  return {crmResult, emailResult};
}

async function processCanonicalCheckout(evt, storage, providers, requestId) {
  const sessionId = providers.stripe.getCheckoutSessionId(evt);
  if (!sessionId) return {ok: true, skipped: true, reason: 'missing session id'};

  const sessionRes = await providers.stripe.getCheckoutSession(sessionId);
  if (!sessionRes.ok) {
    await storage.appendAuditLog({
      event_type: 'stripe_webhook',
      entity_type: 'payment_event',
      entity_id: evt.id || sessionId,
      action: 'checkout_lookup_failed',
      result: 'failed',
      source: 'stripe',
      redacted_error_context: {request_id: requestId, status: sessionRes.status},
    });
    return {ok: false, error: 'stripe_session_lookup_failed', status: 502};
  }

  const session = sessionRes.data || {};
  const purchase = await createPurchaseTruth(storage, {session, event: evt, canonicalEventId: evt.id || sessionId});

  const paymentIsFinal = String(session.payment_status || '').toLowerCase() === 'paid';
  if (!paymentIsFinal) {
    await storage.upsertOrder({
      contact_id: purchase.contact.id,
      product_reference: session.metadata?.price_id || session.metadata?.offer_code || DEFAULT_PRODUCT_REFERENCE,
      provider: 'stripe',
      provider_checkout_session_id: session.id,
      provider_order_id: session.payment_intent?.id || session.payment_intent || null,
      currency: String(session.currency || 'usd').toLowerCase(),
      amount: Number(session.amount_total || QUICKSTART_AMOUNT_CENTS),
      order_status: assertOrderTransition(purchase.order.order_status, 'pending'),
    });
    await storage.appendAuditLog({
      event_type: 'checkout_session',
      entity_type: 'order',
      entity_id: purchase.order.id,
      action: 'pending_payment',
      result: 'ok',
      source: 'stripe',
      redacted_error_context: {request_id: requestId, payment_status: session.payment_status},
    });
    return {ok: true, pending: true};
  }

  await storage.recordFulfillmentEvent({
    order_id: purchase.order.id,
    fulfillment_type: 'buyer_delivery',
    provider: 'render',
    status: assertFulfillmentTransition('pending', 'processing'),
    idempotency_key: `stripe:${session.id}:buyer_delivery`,
    last_error: null,
    completed_at: null,
  });

  const buyerName = session.customer_details?.name || 'Hercules OS Buyer';
  const buyerEmail = session.customer_details?.email || session.customer_email || '';
  const syncResult = await applyBuyerSync(storage, buyerEmail, buyerName);
  const deliveryResult = await providers.fulfillment.deliverAccess({
    sessionId: session.id,
    buyerEmail,
    buyerName,
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
    leadRef: session.metadata?.lead_ref || session.client_reference_id || '',
    offerCode: session.metadata?.offer_code || QUICKSTART_OFFER_CODE,
  });

  const fulfillmentStatus = deliveryResult.ok ? 'completed' : 'failed';
  await storage.recordFulfillmentEvent({
    order_id: purchase.order.id,
    fulfillment_type: 'buyer_delivery',
    provider: 'render',
    status: assertFulfillmentTransition('processing', fulfillmentStatus === 'completed' ? 'completed' : 'failed'),
    idempotency_key: `stripe:${session.id}:buyer_delivery`,
    last_error: deliveryResult.ok ? null : safeText(deliveryResult.error || 'toolkit delivery failed', 180),
    completed_at: deliveryResult.ok ? new Date().toISOString() : null,
  });

  await storage.upsertOrder({
    contact_id: purchase.contact.id,
    product_reference: session.metadata?.price_id || session.metadata?.offer_code || DEFAULT_PRODUCT_REFERENCE,
    provider: 'stripe',
    provider_checkout_session_id: session.id,
    provider_order_id: session.payment_intent?.id || session.payment_intent || null,
    currency: String(session.currency || 'usd').toLowerCase(),
    amount: Number(session.amount_total || QUICKSTART_AMOUNT_CENTS),
    order_status: assertOrderTransition(purchase.order.order_status, fulfillmentStatus === 'completed' ? 'fulfilled' : 'paid'),
  });

  await storage.upsertPayment({
    order_id: purchase.order.id,
    provider: 'stripe',
    provider_customer_id: session.customer || session.customer_details?.email || null,
    payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    charge_id: null,
    amount: Number(session.amount_total || QUICKSTART_AMOUNT_CENTS),
    currency: String(session.currency || 'usd').toLowerCase(),
    payment_status: 'paid',
    test_mode: !Boolean(session.livemode),
  });

  await storage.appendAuditLog({
    event_type: 'checkout_session',
    entity_type: 'order',
    entity_id: purchase.order.id,
    action: 'paid',
    result: fulfillmentStatus === 'completed' ? 'fulfilled' : 'partial_failure',
    source: 'stripe',
    redacted_error_context: {
      request_id: requestId,
      buyer_email_hash: hashNormalizedEmail(buyerEmail),
      crm_mode: syncResult.crmResult.mode,
      email_mode: syncResult.emailResult.mode,
      delivery_status: fulfillmentStatus,
    },
  });

  if (!deliveryResult.ok) {
    return {ok: false, error: 'toolkit_delivery_failed', status: 502};
  }

  return {ok: true, fulfilled: true, deliveryResult, syncResult};
}

async function processPaymentIntentEvent(evt, storage, requestId) {
  const paymentIntentId = stripe.getPaymentIntentId(evt);
  if (!paymentIntentId) return {ok: true, skipped: true, reason: 'missing payment_intent_id'};
  const order = await storage.getOrderByExternalRef({
    provider: 'stripe',
    providerCheckoutSessionId: evt?.data?.object?.metadata?.checkout_session_id || null,
    providerOrderId: paymentIntentId,
  });
  const paymentStatus = evt.type === 'payment_intent.payment_failed' ? 'payment_failed' : 'paid';
  if (order) {
    const nextOrderStatus = order.order_status === 'fulfilled' || order.order_status === 'refunded'
      ? order.order_status
      : (paymentStatus === 'paid' ? 'paid' : 'payment_failed');
    await storage.upsertPayment({
      order_id: order.id,
      provider: 'stripe',
      provider_customer_id: evt?.data?.object?.customer || null,
      payment_intent_id: paymentIntentId,
      charge_id: evt?.data?.object?.charges?.data?.[0]?.id || null,
      amount: Number(evt?.data?.object?.amount_received || evt?.data?.object?.amount || 0),
      currency: String(evt?.data?.object?.currency || 'usd').toLowerCase(),
      payment_status: paymentStatus,
      test_mode: !Boolean(evt.livemode),
    });
    await storage.upsertOrder({
      contact_id: order.contact_id,
      product_reference: order.product_reference,
      provider: 'stripe',
      provider_checkout_session_id: order.provider_checkout_session_id || evt?.data?.object?.metadata?.checkout_session_id || null,
      provider_order_id: paymentIntentId,
      currency: order.currency,
      amount: order.amount,
      order_status: assertOrderTransition(order.order_status, nextOrderStatus),
    });
  }
  await storage.appendAuditLog({
    event_type: 'payment_intent',
    entity_type: 'payment',
    entity_id: paymentIntentId,
    action: evt.type,
    result: order ? 'ok' : 'unlinked',
    source: 'stripe',
    redacted_error_context: {request_id: requestId},
  });
  return {ok: true, recorded: true, linked: Boolean(order)};
}

async function processRefundEvent(evt, storage, requestId) {
  const refund = evt?.data?.object || {};
  const providerRefundId = refund.id || evt.id;
  const paymentIntentId = refund.payment_intent || refund.paymentIntent || '';
  const payment = paymentIntentId ? await storage.getPaymentByIntent(paymentIntentId) : null;
  if (payment) {
    const refundStatus = Number(refund.amount || payment.amount || 0) >= Number(payment.amount || 0) ? 'refunded' : 'partially_refunded';
    await storage.recordRefund({
      payment_id: payment.id,
      provider_refund_id: providerRefundId,
      amount: Number(refund.amount || payment.amount || 0),
      currency: String(refund.currency || payment.currency || 'usd').toLowerCase(),
      refund_status: 'succeeded',
      reason: refund.reason || null,
    });
    await storage.upsertPayment({
      order_id: payment.order_id,
      provider: payment.provider,
      provider_customer_id: payment.provider_customer_id,
      payment_intent_id: payment.payment_intent_id,
      charge_id: payment.charge_id,
      amount: payment.amount,
      currency: payment.currency,
      payment_status: refundStatus,
      test_mode: Boolean(payment.test_mode),
    });
    const order = await storage.getOrderById(payment.order_id);
    if (order) {
      await storage.upsertOrder({
        contact_id: order.contact_id,
        product_reference: order.product_reference,
        provider: order.provider,
        provider_checkout_session_id: order.provider_checkout_session_id,
        provider_order_id: order.provider_order_id,
        currency: order.currency,
        amount: order.amount,
        order_status: assertOrderTransition(order.order_status, refundStatus),
      });
      const buyerEmail = evt?.data?.object?.billing_details?.email || evt?.data?.object?.customer_details?.email || '';
      const buyerName = evt?.data?.object?.billing_details?.name || evt?.data?.object?.customer_details?.name || 'Hercules OS Buyer';
      if (validEmail(buyerEmail)) {
        await applyRefundSync(storage, buyerEmail, buyerName);
      }
      await storage.recordFulfillmentEvent({
        order_id: order.id,
        fulfillment_type: 'refund_reversal',
        provider: 'stripe',
        status: assertFulfillmentTransition('completed', 'reversed'),
        idempotency_key: `stripe:${providerRefundId}:refund`,
        last_error: null,
        completed_at: new Date().toISOString(),
      });
    }
  }
  await storage.appendAuditLog({
    event_type: 'refund',
    entity_type: 'payment',
    entity_id: payment?.id || paymentIntentId || providerRefundId,
    action: 'charge.refunded',
    result: payment ? 'ok' : 'unlinked',
    source: 'stripe',
    redacted_error_context: {request_id: requestId, refund_id: providerRefundId},
  });
  return {ok: true};
}

async function processStripeWebhook(evt, storage, requestId) {
  if (stripe.isCanonicalFulfillmentEvent(evt)) {
    return processCanonicalCheckout(evt, storage, {stripe, fulfillment}, requestId);
  }
  if (stripe.isPaymentStatusEvent(evt)) {
    return processPaymentIntentEvent(evt, storage, requestId);
  }
  if (stripe.isRefundEvent(evt)) {
    return processRefundEvent(evt, storage, requestId);
  }
  return {ok: true, skipped: true};
}

const server = http.createServer(async (req, res) => {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain; charset=utf-8', corsHeaders(req));

  if (req.method === 'GET' && url.pathname === '/health') {
    const storageHealth = await getHealthSnapshot();
    return send(res, 200, {
      ok: true,
      service: 'hos-stripe-bridge',
      requestId,
      canonicalFulfillmentTrigger: 'checkout.session.completed',
      featureFlags: flags,
      envStatus: healthEnvStatus(),
      storageBackend: storageMode,
      storage: storageHealth,
    }, 'application/json; charset=utf-8', corsHeaders(req));
  }

  if (req.method === 'POST' && url.pathname === '/leads/hos-start') {
    try {
      const lead = normalizeLead(await readJson(req));
      if (!validEmail(lead.email)) return send(res, 400, {ok: false, error: 'valid email required'}, 'application/json; charset=utf-8', corsHeaders(req));
      const storage = await getStorage();
      const contact = await createOrLoadContact(storage, lead.email, lead.name, lead.phone || null);
      const crmProvider = createCRMProvider({env: process.env, flags, storage});
      const emailProvider = createEmailProvider({env: process.env, flags, fetch: global.fetch.bind(global), storage});
      const crmResult = await crmProvider.syncLeadContact({email: lead.email, name: lead.name});
      const emailResult = await emailProvider.syncLeadContact({email: lead.email, name: lead.name});
      await storage.appendAuditLog({
        event_type: 'lead_capture',
        entity_type: 'contact',
        entity_id: contact.id,
        action: 'lead_received',
        result: 'ok',
        source: 'eStage',
        redacted_error_context: {request_id: requestId, email_hash: hashNormalizedEmail(lead.email)},
      });
      log('lead-events', {requestId, lead: {emailHash: hashNormalizedEmail(lead.email), name: lead.name, hasPhone: Boolean(lead.phone), source: lead.source}});
      log('lead-results', {requestId, lead: {emailHash: hashNormalizedEmail(lead.email), name: lead.name, source: lead.source}, crmResult, emailResult});
      return send(res, 200, {ok: true, lead: {emailHash: hashNormalizedEmail(lead.email), name: lead.name, source: lead.source}}, 'application/json; charset=utf-8', corsHeaders(req));
    } catch (e) {
      log('errors', {requestId, route: 'leads/hos-start', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message}, 'application/json; charset=utf-8', corsHeaders(req));
    }
  }

  if (req.method === 'POST' && url.pathname === '/checkout/quickstart') {
    try {
      const key = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
      if (isRateLimited(`checkout:${key}`, 10, 60_000)) {
        return send(res, 429, {ok: false, error: 'rate limited'}, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const body = validateCheckoutBody(await readJson(req));
      if (!body.ok) return send(res, 400, {ok: false, error: body.error}, 'application/json; charset=utf-8', corsHeaders(req));
      if (flags.checkoutMode !== 'external') {
        return send(res, 503, {ok: false, error: 'checkout mode is not external'}, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const checkout = await stripe.createCheckoutSession(body.value);
      if (!checkout.ok) {
        log('errors', {requestId, route: 'checkout/quickstart', status: checkout.status, body: checkout.data});
        return send(res, 502, {ok: false, error: 'stripe checkout creation failed', stripe_status: checkout.status}, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const session = checkout.data || {};
      const storage = await getStorage();
      const placeholderEmail = `lead-${body.value.lead_ref.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40)}@staging.invalid`;
      const contact = await createOrLoadContact(storage, placeholderEmail, 'Hercules OS Lead');
      const order = await storage.upsertOrder({
        contact_id: contact.id,
        product_reference: session.metadata?.price_id || DEFAULT_PRODUCT_REFERENCE,
        provider: 'stripe',
        provider_checkout_session_id: session.id,
        provider_order_id: null,
        currency: String(session.currency || QUICKSTART_CURRENCY).toLowerCase(),
        amount: Number(session.amount_total || QUICKSTART_AMOUNT_CENTS),
        order_status: 'pending',
      });
      await storage.appendAuditLog({
        event_type: 'checkout_session',
        entity_type: 'order',
        entity_id: order.id,
        action: 'created',
        result: 'ok',
        source: 'stripe',
        redacted_error_context: {request_id: requestId, lead_ref: body.value.lead_ref},
      });
      log('checkout-sessions', {requestId, sessionId: session.id || '', leadRef: body.value.lead_ref, offerCode: QUICKSTART_OFFER_CODE});
      return send(res, 200, {checkout_url: session.url || '', session_id: session.id || ''}, 'application/json; charset=utf-8', corsHeaders(req));
    } catch (e) {
      log('errors', {requestId, route: 'checkout/quickstart', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message}, 'application/json; charset=utf-8', corsHeaders(req));
    }
  }

  if (req.method === 'GET' && url.pathname === '/checkout/session-status') {
    try {
      const sessionId = safeText(url.searchParams.get('session_id'), 120);
      if (!sessionId || !sessionId.startsWith('cs_')) {
        return send(res, 400, {ok: false, error: 'session_id required'}, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const storage = await getStorage();
      const order = await storage.getOrderByExternalRef({provider: 'stripe', providerCheckoutSessionId: sessionId, providerOrderId: null});
      const payment = order ? await storage.getPaymentByIntent(order.provider_order_id || '') : null;
      const stripeSession = await stripe.getCheckoutSession(sessionId);
      if (!stripeSession.ok) {
        return send(res, stripeSession.status === 404 ? 404 : 502, {ok: false, error: 'stripe session lookup failed', stripe_status: stripeSession.status}, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const session = stripeSession.data || {};
      return send(res, 200, {
        session_id: session.id,
        offer: session.metadata?.offer_code || QUICKSTART_OFFER_CODE,
        payment_status: payment?.payment_status || session.payment_status || 'pending',
        fulfillment_status: order?.order_status || 'pending',
        amount_total: session.amount_total ?? null,
        currency: String(session.currency || '').toLowerCase(),
      }, 'application/json; charset=utf-8', corsHeaders(req));
    } catch (e) {
      log('errors', {requestId, route: 'checkout/session-status', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message}, 'application/json; charset=utf-8', corsHeaders(req));
    }
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/stripe/hos-quickstart') {
    const raw = await readRaw(req);
    const sig = stripe.verifyWebhookSignature(raw, req.headers['stripe-signature']);
    if (!sig.ok) {
      log('stripe-rejected', {requestId, reason: sig.reason});
      return send(res, 400, {ok: false, error: sig.reason});
    }
    let evt;
    try {
      evt = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, {ok: false, error: 'invalid json'});
    }

    const storage = await getStorage();
    const claim = await storage.recordPaymentEvent({
      provider_event_id: evt.id || '',
      event_type: evt.type || '',
      processing_status: 'processing',
      received_at: new Date().toISOString(),
      processed_at: null,
      attempt_count: 1,
      last_error: null,
      payload_ref: `stripe:${evt.id || 'unknown'}`,
      safe_metadata: {
        session_id: evt?.data?.object?.id || null,
        payment_intent: evt?.data?.object?.payment_intent || null,
        charge_id: evt?.data?.object?.id || null,
      },
      livemode: Boolean(evt.livemode),
    });
    if (claim?.processing_status === 'processed') {
      log('stripe-events', {requestId, eventId: evt.id || '', deduped: true, type: evt.type || ''});
      return send(res, 200, {ok: true, deduped: true});
    }

    log('stripe-events', {
      requestId,
      eventId: evt.id || '',
      type: evt.type || '',
      buyer: {
        email: hashNormalizedEmail(evt?.data?.object?.customer_details?.email || evt?.data?.object?.customer_email || ''),
        name: safeText(evt?.data?.object?.customer_details?.name || evt?.data?.object?.billing_details?.name || '', 80),
      },
    });

    try {
      const result = await processStripeWebhook(evt, storage, requestId);
      const failureCode = result.error || 'fulfillment_failed';
      const retryable = !result.ok && RETRYABLE_FULFILLMENT_ERRORS.has(failureCode);
      await storage.markPaymentEventProcessed(evt.id || '', {
        processing_status: result.ok ? 'processed' : (retryable ? 'partial_failure' : 'failed'),
        processed_at: new Date().toISOString(),
        last_error: result.ok ? null : safeText(result.error || 'processing failed', 180),
        safe_metadata: {request_id: requestId, result: safeJson(result)},
      });
      return send(res, result.ok ? 200 : 502, {
        ok: result.ok,
        fulfilled: Boolean(result.fulfilled),
        deduped: Boolean(result.deduped),
        pending: Boolean(result.pending),
      });
    } catch (e) {
      try {
        await storage.markPaymentEventProcessed(evt.id || '', {
          processing_status: 'failed',
          processed_at: new Date().toISOString(),
          last_error: safeText(e.message || String(e), 180),
        });
      } catch {}
      log('errors', {requestId, eventId: evt.id || '', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message});
    }
  }

  send(res, 404, {ok: false, error: 'not found'}, 'application/json; charset=utf-8', corsHeaders(req));
});

function isRateLimited(stateKey, maxRequests = 15, windowMs = 60_000) {
  const now = Date.now();
  const bucket = Array.isArray(rateLimitBuckets.get(stateKey)) ? rateLimitBuckets.get(stateKey).filter(ts => now - ts < windowMs) : [];
  bucket.push(now);
  rateLimitBuckets.set(stateKey, bucket);
  return bucket.length > maxRequests;
}

const rateLimitBuckets = new Map();

if (require.main === module) {
  storagePromise
    .then(() => {
      server.listen(PORT, () => console.log(`HOS Stripe bridge listening on http://127.0.0.1:${PORT}`));
    })
    .catch(err => {
      console.error(err?.stack || String(err));
      process.exit(1);
    });
}

module.exports = {
  server,
  healthEnvStatus,
  validateCheckoutBody,
  ensureOpaqueLeadRef,
  quickstartOfferCode: QUICKSTART_OFFER_CODE,
  quickstartAmountCents: QUICKSTART_AMOUNT_CENTS,
  quickstartCurrency: QUICKSTART_CURRENCY,
};
