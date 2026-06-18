const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {createQuickstartStorage, hashNormalizedEmail} = require('./storage');

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
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY || '';
const GETRESPONSE_BASE_URL = process.env.GETRESPONSE_BASE_URL || 'https://api.getresponse.com/v3';
const HOS_CAMPAIGN_ID = process.env.HOS_GETRESPONSE_CAMPAIGN_ID || 'f12ji';
const HOS_BUYER_TAG_ID = process.env.HOS_BUYER_TAG_ID || '4P1aD';
const HOS_LEAD_TAG_ID = process.env.HOS_LEAD_TAG_ID || '4uKVS';
const HOS_DECLINED_TAG_ID = process.env.HOS_DECLINED_TAG_ID || '';
const STRIPE_PAYMENT_LINK_ID = process.env.STRIPE_PAYMENT_LINK_ID || 'plink_1TcIvYDfPgr5wAVlitvX7U2C';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_QUICKSTART_PRICE_ID = process.env.STRIPE_QUICKSTART_PRICE_ID || '';
const QUICKSTART_SUCCESS_URL = process.env.QUICKSTART_SUCCESS_URL || 'https://herculeswellness.club/start-thank-you-buyer?session_id={CHECKOUT_SESSION_ID}';
const QUICKSTART_CANCEL_URL = process.env.QUICKSTART_CANCEL_URL || 'https://herculeswellness.club/start-thank-you-declined?checkout=cancelled';
const QUICKSTART_ACCESS_URL = process.env.QUICKSTART_ACCESS_URL || '';
const STRIPE_ENVIRONMENT = String(process.env.STRIPE_ENVIRONMENT || 'test').toLowerCase();
const QUICKSTART_OFFER_CODE = 'HOS_QUICKSTART_V3';
const QUICKSTART_AMOUNT_CENTS = 1700;
const QUICKSTART_CURRENCY = 'usd';
const RETRYABLE_FULFILLMENT_ERRORS = new Set([
  'getresponse_failed',
  'toolkit_delivery_failed',
  'stripe_session_lookup_failed',
  'handler_error',
]);
const ALLOWED_ORIGINS = new Set([
  'https://herculeswellness.club',
  'https://www.herculeswellness.club',
  'https://my-web-1696084750836.estage.com',
]);
const LOG_DIR = path.join(process.env.HOS_BRIDGE_LOG_DIR || path.join(__dirname, 'logs'));
const STATE_DIR = path.join(process.env.HOS_BRIDGE_STATE_DIR || path.join(__dirname, 'state'));
const STATE_FILE = path.join(STATE_DIR, 'quickstart-stripe-state.json');
const MIGRATION_FILE = path.join(__dirname, 'migrations', '001_init.sql');

const storagePromise = createQuickstartStorage({
  stateFile: STATE_FILE,
  migrationFile: MIGRATION_FILE,
});

let storageMode = 'initializing';
storagePromise
  .then(storage => {
    storageMode = storage.mode;
    console.log(`Quickstart storage backend: ${storage.mode}`);
    return storage;
  })
  .catch(err => {
    storageMode = 'unavailable';
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
      console.error('Quickstart storage initialization failed in production');
      console.error(err?.stack || String(err));
      process.exit(1);
    } else {
      console.warn('Quickstart storage initialization failed; local fallback was not available');
    }
    return null;
  });

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

if (!GETRESPONSE_API_KEY) console.warn('GETRESPONSE_API_KEY is not set. Contacts cannot be sent to GetResponse.');
if (!STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET is not set. Stripe signature verification will be skipped.');

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://herculeswellness.club';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, stripe-signature',
    'vary': 'Origin',
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {'content-type': type, ...extraHeaders});
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function log(kind, data) {
  fs.appendFileSync(path.join(LOG_DIR, kind + '.jsonl'), JSON.stringify({at: new Date().toISOString(), ...data}) + '\n');
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

function safeText(value, maxLen = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function validateLeadRef(value) {
  const ref = safeText(value, 120);
  if (!ref) return {ok: false, error: 'lead_ref required'};
  if (looksLikeEmail(ref)) return {ok: false, error: 'lead_ref must be opaque'};
  if (!/^[a-zA-Z0-9._:-]+$/.test(ref)) return {ok: false, error: 'lead_ref contains invalid characters'};
  return {ok: true, value: ref};
}

function sanitizeAttribution(value) {
  return safeText(value, 80);
}

function validateQuickstartCheckoutBody(input) {
  const allowed = new Set(['lead_ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);
  for (const key of Object.keys(input || {})) {
    if (!allowed.has(key)) return {ok: false, error: `unknown field: ${key}`};
  }
  const leadRefResult = validateLeadRef(input.lead_ref || generateOpaqueLeadRef());
  if (!leadRefResult.ok) return leadRefResult;
  return {
    ok: true,
    value: {
      lead_ref: leadRefResult.value,
      utm_source: sanitizeAttribution(input.utm_source),
      utm_medium: sanitizeAttribution(input.utm_medium),
      utm_campaign: sanitizeAttribution(input.utm_campaign),
      utm_content: sanitizeAttribution(input.utm_content),
      utm_term: sanitizeAttribution(input.utm_term),
    },
  };
}

function generateOpaqueLeadRef() {
  return 'lr_' + crypto.randomBytes(12).toString('hex');
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

function uniqueTags(existingTags, addTagId, removeTagIds = []) {
  const remove = new Set((removeTagIds || []).filter(Boolean));
  const ids = new Set((existingTags || []).map(t => t && t.tagId).filter(Boolean).filter(id => !remove.has(id)));
  if (addTagId) ids.add(addTagId);
  return [...ids].map(id => ({tagId: id}));
}

async function getStorage() {
  return storagePromise;
}

async function loadState() {
  const storage = await getStorage();
  return storage.loadState();
}

async function saveState(state) {
  const file = STATE_FILE;
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

async function updateSessionState(sessionId, patch) {
  const storage = await getStorage();
  return storage.upsertCheckoutSession(sessionId, patch);
}

async function linkPaymentIntent(sessionId, paymentIntentId) {
  if (!paymentIntentId) return;
  const storage = await getStorage();
  return storage.linkPaymentIntent(sessionId, paymentIntentId);
}

async function updateFulfillmentState(sessionId, patch) {
  const storage = await getStorage();
  return storage.updateFulfillment(sessionId, patch);
}

async function getFulfillmentState(sessionId) {
  const storage = await getStorage();
  return storage.getFulfillment(sessionId);
}

async function claimStripeWebhookEvent(evt) {
  const storage = await getStorage();
  return storage.recordWebhookEvent({
    eventId: evt.id || '',
    eventType: evt.type || '',
    livemode: Boolean(evt.livemode),
  });
}

async function completeStripeWebhookEvent(evt, patch = {}) {
  const storage = await getStorage();
  return storage.markWebhookEventProcessed(evt.id || '', patch);
}

async function recordFulfillmentAction(sessionId, actionType, idempotencyKey, patch = {}) {
  const storage = await getStorage();
  return storage.recordFulfillmentAction(sessionId, actionType, idempotencyKey, patch);
}

async function getSessionByPaymentIntent(paymentIntentId) {
  const storage = await getStorage();
  return storage.getSessionByPaymentIntent(paymentIntentId);
}

function envStatus(value, options = {}) {
  if (!value) return 'absent';
  if (options.mustBeTest && !String(value).startsWith('sk_test_')) return 'wrong mode';
  if (options.mustBeHttpsHerbalifeClub) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['herculeswellness.club', 'www.herculeswellness.club'].includes(url.hostname)) return 'wrong mode';
    } catch {
      return 'wrong mode';
    }
  }
  return 'present';
}

function healthEnvStatus() {
  return {
    GETRESPONSE_API_KEY: envStatus(GETRESPONSE_API_KEY),
    STRIPE_WEBHOOK_SECRET: envStatus(STRIPE_WEBHOOK_SECRET),
    STRIPE_SECRET_KEY: envStatus(STRIPE_SECRET_KEY, {mustBeTest: true}),
    STRIPE_QUICKSTART_PRICE_ID: STRIPE_QUICKSTART_PRICE_ID ? 'present' : 'absent',
    HOS_DECLINED_TAG_ID: HOS_DECLINED_TAG_ID ? 'present' : 'absent',
    QUICKSTART_SUCCESS_URL: envStatus(QUICKSTART_SUCCESS_URL, {mustBeHttpsHerbalifeClub: true}),
    QUICKSTART_CANCEL_URL: envStatus(QUICKSTART_CANCEL_URL, {mustBeHttpsHerbalifeClub: true}),
    QUICKSTART_ACCESS_URL: QUICKSTART_ACCESS_URL ? 'present' : 'absent',
    STRIPE_ENVIRONMENT: STRIPE_ENVIRONMENT === 'test' ? 'present' : 'wrong mode',
  };
}

function verifyStripeSignature(raw, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET) return {ok: true, skipped: true};
  if (!sigHeader) return {ok: false, reason: 'missing stripe-signature'};
  const parts = Object.fromEntries(sigHeader.split(',').map(p => {
    const [k, v] = p.split('=');
    return [k, v];
  }));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return {ok: false, reason: 'malformed stripe-signature'};
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  return {ok: crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)), reason: 'signature mismatch'};
}

function pickBuyer(evt) {
  const obj = evt && evt.data && evt.data.object || {};
  const type = evt.type || '';
  const email = obj.customer_details?.email || obj.customer_email || obj.receipt_email || obj.billing_details?.email || obj.charges?.data?.[0]?.billing_details?.email || '';
  const name = obj.customer_details?.name || obj.billing_details?.name || obj.charges?.data?.[0]?.billing_details?.name || 'Hercules OS Buyer';
  const amount = obj.amount_total ?? obj.amount_received ?? obj.amount ?? null;
  const paymentLink = obj.payment_link || obj.metadata?.payment_link || '';
  const mode = obj.mode || '';
  return {type, email, name, amount, paymentLink, mode, objectId: obj.id || '', objectType: obj.object || ''};
}

function appendFormField(params, key, value) {
  if (value === undefined || value === null || value === '') return;
  params.append(key, String(value));
}

async function stripeRequest(method, pathname, bodyParams) {
  const headers = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
  };
  let body = undefined;
  if (bodyParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = bodyParams.toString();
  }
  const res = await fetch(`https://api.stripe.com${pathname}`, {method, headers, body});
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {raw: text};
  }
  return {ok: res.ok, status: res.status, data: parsed};
}

async function createCheckoutSession(payload) {
  const params = new URLSearchParams();
  appendFormField(params, 'mode', 'payment');
  appendFormField(params, 'line_items[0][price]', STRIPE_QUICKSTART_PRICE_ID);
  appendFormField(params, 'line_items[0][quantity]', 1);
  appendFormField(params, 'success_url', QUICKSTART_SUCCESS_URL);
  appendFormField(params, 'cancel_url', QUICKSTART_CANCEL_URL);
  appendFormField(params, 'client_reference_id', payload.lead_ref);
  appendFormField(params, 'metadata[offer_code]', QUICKSTART_OFFER_CODE);
  appendFormField(params, 'metadata[price_id]', STRIPE_QUICKSTART_PRICE_ID);
  appendFormField(params, 'metadata[lead_ref]', payload.lead_ref);
  appendFormField(params, 'metadata[utm_source]', payload.utm_source);
  appendFormField(params, 'metadata[utm_medium]', payload.utm_medium);
  appendFormField(params, 'metadata[utm_campaign]', payload.utm_campaign);
  appendFormField(params, 'metadata[utm_content]', payload.utm_content);
  appendFormField(params, 'metadata[utm_term]', payload.utm_term);
  appendFormField(params, 'payment_intent_data[metadata][offer_code]', QUICKSTART_OFFER_CODE);
  appendFormField(params, 'payment_intent_data[metadata][price_id]', STRIPE_QUICKSTART_PRICE_ID);
  appendFormField(params, 'payment_intent_data[metadata][lead_ref]', payload.lead_ref);
  appendFormField(params, 'payment_intent_data[metadata][utm_source]', payload.utm_source);
  appendFormField(params, 'payment_intent_data[metadata][utm_medium]', payload.utm_medium);
  appendFormField(params, 'payment_intent_data[metadata][utm_campaign]', payload.utm_campaign);
  appendFormField(params, 'payment_intent_data[metadata][utm_content]', payload.utm_content);
  appendFormField(params, 'payment_intent_data[metadata][utm_term]', payload.utm_term);
  appendFormField(params, 'payment_intent_data[statement_descriptor]', 'HOS QUICKSTART');
  return stripeRequest('POST', '/v1/checkout/sessions', params);
}

async function getCheckoutSession(sessionId) {
  const params = new URLSearchParams();
  params.append('expand[]', 'payment_intent');
  params.append('expand[]', 'line_items');
  params.append('expand[]', 'payment_link');
  return stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`);
}

async function upsertGetResponseContact({email, name, addTagId, removeTagIds = [], defaultName}) {
  const headers = {'Content-Type': 'application/json', 'X-Auth-Token': `api-key ${GETRESPONSE_API_KEY}`};
  const queryUrl = `${GETRESPONSE_BASE_URL}/contacts?query[email]=${encodeURIComponent(email)}`;
  const existingRes = await fetch(queryUrl, {headers});
  const existingText = await existingRes.text();
  let existing = [];
  try {
    existing = JSON.parse(existingText);
  } catch {}
  if (Array.isArray(existing) && existing[0]?.contactId) {
    const contactId = existing[0].contactId;
    const patchBody = {
      name: name || existing[0].name || defaultName,
      campaign: {campaignId: HOS_CAMPAIGN_ID},
      tags: uniqueTags(existing[0].tags, addTagId, removeTagIds),
    };
    const patch = await fetch(`${GETRESPONSE_BASE_URL}/contacts/${contactId}`, {method: 'POST', headers, body: JSON.stringify(patchBody)});
    const body = await patch.text();
    return {mode: 'update', contactId, status: patch.status, ok: patch.ok, body};
  }
  const createBody = {email, name: name || defaultName, campaign: {campaignId: HOS_CAMPAIGN_ID}, dayOfCycle: '0'};
  if (addTagId) createBody.tags = [{tagId: addTagId}];
  const create = await fetch(`${GETRESPONSE_BASE_URL}/contacts`, {method: 'POST', headers, body: JSON.stringify(createBody)});
  const body = await create.text();
  return {mode: 'create', status: create.status, ok: create.ok || create.status === 202, body};
}

async function upsertBuyerContact({email, name}) {
  return upsertGetResponseContact({
    email,
    name,
    addTagId: HOS_BUYER_TAG_ID,
    removeTagIds: [HOS_LEAD_TAG_ID, HOS_DECLINED_TAG_ID],
    defaultName: 'Hercules OS Buyer',
  });
}

async function upsertLeadContact({email, name}) {
  return upsertGetResponseContact({email, name, addTagId: HOS_LEAD_TAG_ID, defaultName: 'Hercules OS Lead'});
}

async function triggerToolkitAccessDelivery({sessionId, buyerEmail, buyerName, paymentIntent, leadRef}) {
  if (!QUICKSTART_ACCESS_URL) return {ok: true, skipped: true};
  try {
    const res = await fetch(QUICKSTART_ACCESS_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        offer_code: QUICKSTART_OFFER_CODE,
        session_id: sessionId,
        buyer_email: buyerEmail,
        buyer_name: buyerName,
        payment_intent: paymentIntent,
        lead_ref: leadRef,
      }),
    });
    const text = await res.text();
    return {ok: res.ok, status: res.status, body: text.slice(0, 300), delivered: res.ok};
  } catch (error) {
    return {ok: false, error: error.message};
  }
}

function rateLimitKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

const rateLimitBuckets = new Map();

function isRateLimited(stateKey, maxRequests = 15, windowMs = 60_000) {
  const now = Date.now();
  const bucket = Array.isArray(rateLimitBuckets.get(stateKey)) ? rateLimitBuckets.get(stateKey).filter(ts => now - ts < windowMs) : [];
  bucket.push(now);
  rateLimitBuckets.set(stateKey, bucket);
  return bucket.length > maxRequests;
}

async function normalizeSessionObject(session) {
  const metadata = session?.metadata || {};
  const lineItems = session?.line_items?.data || [];
  const price = lineItems[0]?.price || {};
  const fulfillment = await getFulfillmentState(session?.id || '');
  return {
    id: session?.id || '',
    offer: metadata.offer_code || QUICKSTART_OFFER_CODE,
    amount_total: session?.amount_total ?? null,
    currency: String(session?.currency || '').toLowerCase(),
    payment_status: session?.payment_status || 'unpaid',
    payment_intent: typeof session?.payment_intent === 'string' ? session.payment_intent : session?.payment_intent?.id || '',
    customer_email: session?.customer_details?.email || session?.customer_email || '',
    customer_name: session?.customer_details?.name || '',
    price_id: metadata.price_id || price?.id || '',
    fulfillment_status: fulfillment.status || 'pending',
  };
}

async function handleFulfillmentFromSession(session, sourceEvent) {
  const sessionId = session?.id || '';
  if (!sessionId) return {ok: false, error: 'missing session id'};

  const amountOk = Number(session.amount_total || 0) === QUICKSTART_AMOUNT_CENTS;
  const currencyOk = String(session.currency || '').toLowerCase() === QUICKSTART_CURRENCY;
  const priceId = session.metadata?.price_id || session.line_items?.data?.[0]?.price?.id || '';
  const priceOk = !STRIPE_QUICKSTART_PRICE_ID || priceId === STRIPE_QUICKSTART_PRICE_ID;
  const paymentStatusOk = session.payment_status === 'paid';

  await updateSessionState(sessionId, {
    offer: QUICKSTART_OFFER_CODE,
    amount_total: session.amount_total ?? null,
    currency: session.currency || '',
    payment_status: session.payment_status || '',
    payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
    customer_email: session.customer_details?.email || session.customer_email || '',
    customer_name: session.customer_details?.name || '',
    offer_code: session.metadata?.offer_code || QUICKSTART_OFFER_CODE,
    lead_ref: session.metadata?.lead_ref || session.client_reference_id || '',
    price_id: priceId,
    last_event_id: sourceEvent?.id || '',
  });
  await linkPaymentIntent(sessionId, typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '');
  await recordFulfillmentAction(sessionId, 'purchase_event_recorded', sourceEvent?.id || sessionId, {
    status: 'in_progress',
  });

  if (!amountOk || !currencyOk || !priceOk) {
    await updateFulfillmentState(sessionId, {
      status: 'failed',
      reason: 'amount_currency_price_mismatch',
      amount_total: session.amount_total ?? null,
      currency: session.currency || '',
      price_id: priceId,
    });
    await recordFulfillmentAction(sessionId, 'purchase_event_recorded', sourceEvent?.id || sessionId, {
      status: 'failed',
      error_code: 'amount_currency_price_mismatch',
      error_message_safe: 'amount, currency, or price mismatch',
      completed_at: new Date().toISOString(),
    });
    log('support-alerts', {sessionId, reason: 'amount_currency_price_mismatch', sourceEventId: sourceEvent?.id || ''});
    return {ok: false, error: 'amount_currency_price_mismatch'};
  }

  if (!paymentStatusOk) {
    await updateFulfillmentState(sessionId, {
      status: 'pending',
      reason: 'payment_not_final',
      payment_status: session.payment_status || '',
    });
    await recordFulfillmentAction(sessionId, 'purchase_event_recorded', sourceEvent?.id || sessionId, {
      status: 'skipped',
      error_code: 'payment_not_final',
      error_message_safe: 'payment is not final',
      completed_at: new Date().toISOString(),
    });
    return {ok: true, pending: true};
  }

  const existingFulfillment = await getFulfillmentState(sessionId);
  if (existingFulfillment.status === 'fulfilled') {
    return {ok: true, deduped: true, fulfillment: existingFulfillment};
  }

  const email = session.customer_details?.email || session.customer_email || sourceEvent?.data?.object?.customer_details?.email || sourceEvent?.data?.object?.customer_email || '';
  if (!validEmail(email)) {
    await updateFulfillmentState(sessionId, {
      status: 'failed',
      reason: 'missing_buyer_email',
    });
    await recordFulfillmentAction(sessionId, 'purchase_event_recorded', sourceEvent?.id || sessionId, {
      status: 'failed',
      error_code: 'missing_buyer_email',
      error_message_safe: 'buyer email missing or invalid',
      completed_at: new Date().toISOString(),
    });
    log('support-alerts', {sessionId, reason: 'missing_buyer_email', sourceEventId: sourceEvent?.id || ''});
    return {ok: false, error: 'missing_buyer_email'};
  }

  const buyerName = session.customer_details?.name || sourceEvent?.data?.object?.customer_details?.name || 'Hercules OS Buyer';
  const gr = await upsertBuyerContact({email, name: buyerName});
  if (!gr.ok) {
    await updateFulfillmentState(sessionId, {
      status: 'partial_failure',
      reason: 'getresponse_failed',
      buyer_email_hash: hashNormalizedEmail(email),
      payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
      source_event_id: sourceEvent?.id || '',
      access_url: QUICKSTART_ACCESS_URL || '',
      sequence_state: 'buyer',
    });
    await recordFulfillmentAction(sessionId, 'buyer_tag_added', sourceEvent?.id || sessionId, {
      status: 'failed',
      error_code: 'getresponse_failed',
      error_message_safe: 'buyer tag update failed',
    });
    await recordFulfillmentAction(sessionId, 'purchase_event_recorded', sourceEvent?.id || sessionId, {
      status: 'failed',
      error_code: 'getresponse_failed',
      error_message_safe: 'getresponse buyer update failed',
      completed_at: new Date().toISOString(),
    });
    log('errors', {sessionId, eventId: sourceEvent?.id || '', error: 'getresponse buyer update failed', gr});
    log('support-alerts', {sessionId, reason: 'getresponse buyer update failed', sourceEventId: sourceEvent?.id || ''});
    return {ok: false, error: 'getresponse buyer update failed', gr};
  }
  await recordFulfillmentAction(sessionId, 'buyer_tag_added', sourceEvent?.id || sessionId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
  });
  await recordFulfillmentAction(sessionId, 'declined_tag_removed', sourceEvent?.id || sessionId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
  });
  await recordFulfillmentAction(sessionId, 'buyer_delivery_started', sourceEvent?.id || sessionId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
  });

  const deliveryResult = await triggerToolkitAccessDelivery({
    sessionId,
    buyerEmail: email,
    buyerName,
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
    leadRef: session.metadata?.lead_ref || session.client_reference_id || '',
  });

  if (!deliveryResult.ok) {
    await updateFulfillmentState(sessionId, {
      status: 'partial_failure',
      reason: 'toolkit_delivery_failed',
      buyer_email_hash: hashNormalizedEmail(email),
      payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
      source_event_id: sourceEvent?.id || '',
      access_url: QUICKSTART_ACCESS_URL || '',
      sequence_state: 'buyer',
    });
    await recordFulfillmentAction(sessionId, 'toolkit_access_delivered', sourceEvent?.id || sessionId, {
      status: 'failed',
      error_code: 'toolkit_delivery_failed',
      error_message_safe: 'toolkit access delivery failed',
    });
    await recordFulfillmentAction(sessionId, 'purchase_event_recorded', sourceEvent?.id || sessionId, {
      status: 'failed',
      error_code: 'toolkit_delivery_failed',
      error_message_safe: 'toolkit access delivery failed',
      completed_at: new Date().toISOString(),
    });
    log('errors', {sessionId, eventId: sourceEvent?.id || '', error: 'toolkit access delivery failed', deliveryResult});
    log('support-alerts', {sessionId, reason: 'toolkit_access_delivery_failed', sourceEventId: sourceEvent?.id || ''});
    return {ok: false, error: 'toolkit access delivery failed', deliveryResult};
  }
  await recordFulfillmentAction(sessionId, 'toolkit_access_delivered', sourceEvent?.id || sessionId, {
    status: deliveryResult.skipped ? 'skipped' : 'completed',
    completed_at: new Date().toISOString(),
  });

    await updateFulfillmentState(sessionId, {
    status: 'fulfilled',
      reason: deliveryResult.skipped ? 'buyer_tagged' : 'buyer_tagged_and_delivered',
      buyer_email_hash: hashNormalizedEmail(email),
      payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
      source_event_id: sourceEvent?.id || '',
      access_url: QUICKSTART_ACCESS_URL || '',
      sequence_state: 'buyer',
      fulfilled_at: new Date().toISOString(),
      buyer_tag_status: 'completed',
      declined_tag_removal_status: 'completed',
      buyer_delivery_status: 'completed',
      toolkit_delivery_status: deliveryResult.skipped ? 'skipped' : 'completed',
    });
  await recordFulfillmentAction(sessionId, 'purchase_event_recorded', sourceEvent?.id || sessionId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
  });
  log('getresponse-results', {sessionId, buyerEmailHash: hashNormalizedEmail(email), gr, offerCode: QUICKSTART_OFFER_CODE});
  log('quickstart-fulfillment', {
    sessionId,
    eventId: sourceEvent?.id || '',
    buyerEmailHash: hashNormalizedEmail(email),
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
    accessUrlConfigured: Boolean(QUICKSTART_ACCESS_URL),
    deliveryResult,
  });
  return {ok: true, fulfilled: true, deliveryResult};
}

async function handleRefundEvent(evt) {
  const obj = evt?.data?.object || {};
  const paymentIntentId = obj.payment_intent || obj.paymentIntent || '';
  const chargeId = obj.id || '';
  const relatedSessionId = obj.metadata?.checkout_session_id || obj.metadata?.session_id || '';
  const storage = await getStorage();
  const mappedSession = relatedSessionId ? await storage.getCheckoutSession(relatedSessionId) : await getSessionByPaymentIntent(paymentIntentId);
  const mappedSessionId = relatedSessionId || mappedSession?.stripe_session_id || mappedSession?.id || '';
  if (mappedSessionId) {
    await updateFulfillmentState(mappedSessionId, {
      status: 'failed',
      reason: 'refunded',
      refunded_event_id: evt.id || '',
      payment_intent: paymentIntentId || '',
      charge_id: chargeId || '',
      refunded_at: new Date().toISOString(),
    });
    await recordFulfillmentAction(mappedSessionId, 'refund_recorded', evt.id || paymentIntentId || chargeId || 'refund', {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
  }
  log('refund-events', {
    eventId: evt.id || '',
    paymentIntentId,
    chargeId,
    relatedSessionId: mappedSessionId,
  });
  return {ok: true};
}

async function ensureQuickstartReadyForCheckout() {
  const statuses = healthEnvStatus();
  if (statuses.STRIPE_SECRET_KEY !== 'present') return {ok: false, error: 'STRIPE_SECRET_KEY must be a test key'};
  if (statuses.STRIPE_ENVIRONMENT !== 'present') return {ok: false, error: 'STRIPE_ENVIRONMENT must be test'};
  if (statuses.STRIPE_QUICKSTART_PRICE_ID !== 'present') return {ok: false, error: 'STRIPE_QUICKSTART_PRICE_ID required'};
  if (statuses.QUICKSTART_SUCCESS_URL !== 'present') return {ok: false, error: 'QUICKSTART_SUCCESS_URL must target HerculesWellness.club'};
  if (statuses.QUICKSTART_CANCEL_URL !== 'present') return {ok: false, error: 'QUICKSTART_CANCEL_URL must target HerculesWellness.club'};
  try {
    await getStorage();
  } catch (error) {
    return {ok: false, error: 'durable storage unavailable'};
  }
  return {ok: true};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain; charset=utf-8', corsHeaders(req));

  if (req.method === 'GET' && url.pathname === '/health') {
    let storageHealth = {mode: storageMode, available: false, fallbackReason: 'initializing'};
    try {
      const storage = await getStorage();
      storageHealth = storage.health();
    } catch (error) {
      storageHealth = {mode: storageMode, available: false, fallbackReason: safeText(error.message || 'storage unavailable', 120)};
    }
    return send(res, 200, {
      ok: true,
      service: 'hos-stripe-bridge',
      campaignId: HOS_CAMPAIGN_ID,
      leadTagId: HOS_LEAD_TAG_ID,
      buyerTagId: HOS_BUYER_TAG_ID,
      declinedTagId: HOS_DECLINED_TAG_ID,
      paymentLinkId: STRIPE_PAYMENT_LINK_ID,
      signatureVerification: Boolean(STRIPE_WEBHOOK_SECRET),
      getResponseConfigured: Boolean(GETRESPONSE_API_KEY),
      quickstart: {
        offerCode: QUICKSTART_OFFER_CODE,
        amountCents: QUICKSTART_AMOUNT_CENTS,
        currency: QUICKSTART_CURRENCY,
      },
      storageBackend: storageMode,
      envStatus: healthEnvStatus(),
      storage: storageHealth,
    }, 'application/json; charset=utf-8', corsHeaders(req));
  }

  if (req.method === 'POST' && url.pathname === '/leads/hos-start') {
    try {
      const lead = normalizeLead(await readJson(req));
      if (!validEmail(lead.email)) return send(res, 400, {ok: false, error: 'valid email required'}, 'application/json; charset=utf-8', corsHeaders(req));
      log('lead-events', {lead: {emailHash: hashNormalizedEmail(lead.email), name: lead.name, hasPhone: Boolean(lead.phone), source: lead.source}});
      const gr = await upsertLeadContact(lead);
      log('lead-results', {lead: {emailHash: hashNormalizedEmail(lead.email), name: lead.name, source: lead.source}, gr});
      return send(res, gr.ok ? 200 : 502, {ok: gr.ok, lead: {emailHash: hashNormalizedEmail(lead.email), name: lead.name, source: lead.source}, getresponse: gr}, 'application/json; charset=utf-8', corsHeaders(req));
    } catch (e) {
      log('errors', {route: 'leads/hos-start', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message}, 'application/json; charset=utf-8', corsHeaders(req));
    }
  }

  if (req.method === 'POST' && url.pathname === '/checkout/quickstart') {
    try {
      const key = rateLimitKey(req);
      if (isRateLimited(`checkout:${key}`, 10, 60_000)) {
        return send(res, 429, {ok: false, error: 'rate limited'}, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const body = validateQuickstartCheckoutBody(await readJson(req));
      if (!body.ok) return send(res, 400, {ok: false, error: body.error}, 'application/json; charset=utf-8', corsHeaders(req));
      const prereq = await ensureQuickstartReadyForCheckout();
      if (!prereq.ok) return send(res, 503, {ok: false, error: prereq.error, envStatus: healthEnvStatus()}, 'application/json; charset=utf-8', corsHeaders(req));

      const checkout = await createCheckoutSession(body.value);
      if (!checkout.ok) {
        log('errors', {route: 'checkout/quickstart', status: checkout.status, body: checkout.data});
        return send(res, 502, {
          ok: false,
          error: 'stripe checkout creation failed',
          stripe_status: checkout.status,
        }, 'application/json; charset=utf-8', corsHeaders(req));
      }

      const session = checkout.data || {};
      await updateSessionState(session.id, {
        offer: QUICKSTART_OFFER_CODE,
        amount_total: session.amount_total ?? QUICKSTART_AMOUNT_CENTS,
        currency: session.currency || QUICKSTART_CURRENCY,
        payment_status: session.payment_status || 'unpaid',
        client_reference_id: body.value.lead_ref,
        lead_ref: body.value.lead_ref,
        offer_code: QUICKSTART_OFFER_CODE,
        price_id: STRIPE_QUICKSTART_PRICE_ID,
        fulfillment_status: 'pending',
        checkout_url: session.url || '',
        created_via: 'checkout/quickstart',
        utm_source: body.value.utm_source,
        utm_medium: body.value.utm_medium,
        utm_campaign: body.value.utm_campaign,
        utm_content: body.value.utm_content,
        utm_term: body.value.utm_term,
      });
      log('checkout-sessions', {
        sessionId: session.id || '',
        leadRef: body.value.lead_ref,
        offerCode: QUICKSTART_OFFER_CODE,
        environment: STRIPE_ENVIRONMENT,
      });
      return send(res, 200, {
        checkout_url: session.url || '',
        session_id: session.id || '',
      }, 'application/json; charset=utf-8', corsHeaders(req));
    } catch (e) {
      log('errors', {route: 'checkout/quickstart', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message}, 'application/json; charset=utf-8', corsHeaders(req));
    }
  }

  if (req.method === 'GET' && url.pathname === '/checkout/session-status') {
    try {
      const sessionId = safeText(url.searchParams.get('session_id'), 120);
      if (!sessionId || !sessionId.startsWith('cs_')) {
        return send(res, 400, {ok: false, error: 'session_id required'}, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const stripeSession = await getCheckoutSession(sessionId);
      if (!stripeSession.ok) {
        return send(res, stripeSession.status === 404 ? 404 : 502, {
          ok: false,
          error: 'stripe session lookup failed',
          stripe_status: stripeSession.status,
        }, 'application/json; charset=utf-8', corsHeaders(req));
      }
      const session = await normalizeSessionObject(stripeSession.data || {});
      const fulfillment = await getFulfillmentState(sessionId);
      return send(res, 200, {
        session_id: session.id,
        offer: session.offer,
        payment_status: session.payment_status,
        fulfillment_status: fulfillment.status || 'pending',
        amount_total: session.amount_total ?? null,
        currency: session.currency || '',
      }, 'application/json; charset=utf-8', corsHeaders(req));
    } catch (e) {
      log('errors', {route: 'checkout/session-status', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message}, 'application/json; charset=utf-8', corsHeaders(req));
    }
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/stripe/hos-quickstart') {
    const raw = await readRaw(req);
    const sig = verifyStripeSignature(raw, req.headers['stripe-signature']);
    if (!sig.ok) {
      log('stripe-rejected', {reason: sig.reason});
      return send(res, 400, {ok: false, error: sig.reason});
    }
    let evt;
    try {
      evt = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return send(res, 400, {ok: false, error: 'invalid json'});
    }

    const storage = await getStorage();
    const claim = await storage.recordWebhookEvent({
      eventId: evt.id || '',
      eventType: evt.type || '',
      livemode: Boolean(evt.livemode),
    });
    if (claim.deduped) {
      log('stripe-events', {eventId: evt.id || '', deduped: true, type: evt.type || ''});
      return send(res, 200, {ok: true, deduped: true});
    }

    const buyer = pickBuyer(evt);
    log('stripe-events', {eventId: evt.id || '', buyer: {...buyer, email: buyer.email ? hashNormalizedEmail(buyer.email) : ''}});

    try {
      if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
        const sessionId = evt?.data?.object?.id || '';
        if (!sessionId) return send(res, 200, {ok: true, skipped: true, reason: 'missing session id'});
        const sessionRes = await getCheckoutSession(sessionId);
        if (!sessionRes.ok) {
          await updateFulfillmentState(sessionId, {status: 'partial_failure', reason: 'stripe_session_lookup_failed', source_event_id: evt.id || ''});
          await completeStripeWebhookEvent(evt, {processing_status: 'partial_failure', error_code: 'stripe_session_lookup_failed', error_message_safe: 'stripe session lookup failed'});
          log('support-alerts', {sessionId, reason: 'stripe_session_lookup_failed', sourceEventId: evt.id || ''});
          return send(res, 502, {ok: false, error: 'stripe session lookup failed'});
        }
        const result = await handleFulfillmentFromSession(sessionRes.data || {}, evt);
        const failureCode = result.error || 'fulfillment_failed';
        const retryable = !result.ok && RETRYABLE_FULFILLMENT_ERRORS.has(failureCode);
        await completeStripeWebhookEvent(evt, {
          processing_status: result.ok ? 'processed' : (retryable ? 'partial_failure' : 'failed'),
          error_code: result.ok ? null : failureCode,
          error_message_safe: result.ok ? null : safeText(result.error || 'fulfillment failed', 180),
        });
        log('getresponse-results', {eventId: evt.id || '', sessionId, result});
        return send(res, result.ok ? 200 : 502, {
          ok: result.ok,
          fulfilled: Boolean(result.fulfilled),
          deduped: Boolean(result.deduped),
          pending: Boolean(result.pending),
        });
      }

      if (evt.type === 'checkout.session.async_payment_failed') {
        const sessionId = evt?.data?.object?.id || '';
        if (sessionId) {
          await updateFulfillmentState(sessionId, {
            status: 'failed',
            reason: 'async_payment_failed',
            source_event_id: evt.id || '',
          });
          await completeStripeWebhookEvent(evt, {processing_status: 'processed'});
          log('support-alerts', {sessionId, reason: 'async_payment_failed', sourceEventId: evt.id || ''});
        }
        return send(res, 200, {ok: true, recorded: true});
      }

      if (evt.type === 'charge.refunded' || evt.type === 'charge.refund.updated' || evt.type === 'refund.updated') {
        const result = await handleRefundEvent(evt);
        await completeStripeWebhookEvent(evt, {processing_status: 'processed'});
        return send(res, 200, result);
      }

      await completeStripeWebhookEvent(evt, {processing_status: 'processed'});
      return send(res, 200, {ok: true, skipped: true, buyer});
    } catch (e) {
      try {
        await completeStripeWebhookEvent(evt, {
          processing_status: 'failed',
          error_code: 'handler_error',
          error_message_safe: safeText(e.message || String(e), 180),
        });
      } catch {}
      log('errors', {eventId: evt.id || '', error: e.stack || String(e)});
      return send(res, 500, {ok: false, error: e.message});
    }
  }

  send(res, 404, {ok: false, error: 'not found'}, 'application/json; charset=utf-8', corsHeaders(req));
});

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
  validateQuickstartCheckoutBody,
  ensureQuickstartReadyForCheckout,
  getFulfillmentState,
  loadState,
  saveState,
  STATE_FILE,
  QUICKSTART_OFFER_CODE,
  QUICKSTART_AMOUNT_CENTS,
  QUICKSTART_CURRENCY,
};
