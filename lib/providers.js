const crypto = require('crypto');

function safeText(value, maxLen = 180) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function hashNormalizedEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function createStripeProvider({env, fetch, logger}) {
  const STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY || '';
  const STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET || '';
  const STRIPE_QUICKSTART_PRICE_ID = env.STRIPE_QUICKSTART_PRICE_ID || '';
  const QUICKSTART_SUCCESS_URL = env.QUICKSTART_SUCCESS_URL || '';
  const QUICKSTART_CANCEL_URL = env.QUICKSTART_CANCEL_URL || '';

  function verifyWebhookSignature(raw, sigHeader) {
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
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(v1);
    if (expectedBuf.length !== providedBuf.length) return {ok: false, reason: 'signature mismatch'};
    return {ok: crypto.timingSafeEqual(expectedBuf, providedBuf), reason: 'signature mismatch'};
  }

  async function stripeRequest(method, pathname, bodyParams) {
    const headers = {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    };
    let body;
    if (bodyParams) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = bodyParams.toString();
    }
    const res = await fetch(`https://api.stripe.com${pathname}`, {method, headers, body});
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {raw: text};
    }
    return {ok: res.ok, status: res.status, data: parsed};
  }

  function appendFormField(params, key, value) {
    if (value === undefined || value === null || value === '') return;
    params.append(key, String(value));
  }

  async function createCheckoutSession(payload) {
    const params = new URLSearchParams();
    appendFormField(params, 'mode', 'payment');
    appendFormField(params, 'line_items[0][price]', STRIPE_QUICKSTART_PRICE_ID);
    appendFormField(params, 'line_items[0][quantity]', 1);
    appendFormField(params, 'success_url', QUICKSTART_SUCCESS_URL);
    appendFormField(params, 'cancel_url', QUICKSTART_CANCEL_URL);
    appendFormField(params, 'client_reference_id', payload.lead_ref);
    appendFormField(params, 'metadata[offer_code]', 'HOS_QUICKSTART_V3');
    appendFormField(params, 'metadata[price_id]', STRIPE_QUICKSTART_PRICE_ID);
    appendFormField(params, 'metadata[lead_ref]', payload.lead_ref);
    appendFormField(params, 'metadata[utm_source]', payload.utm_source);
    appendFormField(params, 'metadata[utm_medium]', payload.utm_medium);
    appendFormField(params, 'metadata[utm_campaign]', payload.utm_campaign);
    appendFormField(params, 'metadata[utm_content]', payload.utm_content);
    appendFormField(params, 'metadata[utm_term]', payload.utm_term);
    appendFormField(params, 'payment_intent_data[metadata][offer_code]', 'HOS_QUICKSTART_V3');
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

  function parseEventKind(evt) {
    return String(evt?.type || '');
  }

  function getCheckoutSessionId(evt) {
    return evt?.data?.object?.id || '';
  }

  function getPaymentIntentId(evt) {
    return evt?.data?.object?.payment_intent || evt?.data?.object?.id || '';
  }

  function getChargeId(evt) {
    return evt?.data?.object?.id || '';
  }

  function isCanonicalFulfillmentEvent(evt) {
    return parseEventKind(evt) === 'checkout.session.completed';
  }

  function isPaymentStatusEvent(evt) {
    const type = parseEventKind(evt);
    return type === 'payment_intent.succeeded' || type === 'payment_intent.payment_failed';
  }

  function isRefundEvent(evt) {
    return parseEventKind(evt) === 'charge.refunded';
  }

  return {
    verifyWebhookSignature,
    createCheckoutSession,
    getCheckoutSession,
    parseEventKind,
    getCheckoutSessionId,
    getPaymentIntentId,
    getChargeId,
    isCanonicalFulfillmentEvent,
    isPaymentStatusEvent,
    isRefundEvent,
    hashNormalizedEmail,
    stripeRequest,
  };
}

function createCRMProvider({env, flags, storage}) {
  const ESTAGE_SYNC_ENABLED = Boolean(flags.enableEstateSync);

  async function syncLeadContact({email, name}) {
    if (!ESTAGE_SYNC_ENABLED) return {ok: true, skipped: true, mode: 'estage'};
    await storage?.appendAuditLog({
      event_type: 'crm_sync',
      entity_type: 'contact',
      entity_id: hashNormalizedEmail(email),
      action: 'lead_sync',
      result: 'skipped_no_estage_api',
      source: 'estage',
      redacted_error_context: null,
    }).catch(() => {});
    return {ok: true, skipped: true, mode: 'estage'};
  }

  async function syncBuyerContact({email, name}) {
    if (!ESTAGE_SYNC_ENABLED) return {ok: true, skipped: true, mode: 'estage'};
    await storage?.appendAuditLog({
      event_type: 'crm_sync',
      entity_type: 'contact',
      entity_id: hashNormalizedEmail(email),
      action: 'buyer_sync',
      result: 'skipped_no_estage_api',
      source: 'estage',
      redacted_error_context: null,
    }).catch(() => {});
    return {ok: true, skipped: true, mode: 'estage'};
  }

  async function syncRefundState({email, name}) {
    if (!ESTAGE_SYNC_ENABLED) return {ok: true, skipped: true, mode: 'estage'};
    await storage?.appendAuditLog({
      event_type: 'crm_sync',
      entity_type: 'contact',
      entity_id: hashNormalizedEmail(email),
      action: 'refund_sync',
      result: 'skipped_no_estage_api',
      source: 'estage',
      redacted_error_context: null,
    }).catch(() => {});
    return {ok: true, skipped: true, mode: 'estage'};
  }

  return {
    syncLeadContact,
    syncBuyerContact,
    syncRefundState,
  };
}

function createEmailProvider({env, flags, fetch, storage}) {
  const GETRESPONSE_API_KEY = env.GETRESPONSE_API_KEY || '';
  const GETRESPONSE_BASE_URL = env.GETRESPONSE_BASE_URL || 'https://api.getresponse.com/v3';
  const HOS_CAMPAIGN_ID = env.HOS_GETRESPONSE_CAMPAIGN_ID || '';
  const HOS_BUYER_TAG_ID = env.HOS_BUYER_TAG_ID || '';
  const HOS_LEAD_TAG_ID = env.HOS_LEAD_TAG_ID || '';
  const HOS_DECLINED_TAG_ID = env.HOS_DECLINED_TAG_ID || '';

  function uniqueTags(existingTags, addTagId, removeTagIds = []) {
    const remove = new Set((removeTagIds || []).filter(Boolean));
    const ids = new Set((existingTags || []).map(t => t && t.tagId).filter(Boolean).filter(id => !remove.has(id)));
    if (addTagId) ids.add(addTagId);
    return [...ids].map(id => ({tagId: id}));
  }

  async function upsertGetResponseContact({email, name, addTagId, removeTagIds = [], defaultName}) {
    if (!flags.enableGetResponseSync || !GETRESPONSE_API_KEY) {
      return {ok: true, skipped: true, mode: 'getresponse'};
    }
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

  async function syncLeadContact({email, name}) {
    const result = await upsertGetResponseContact({
      email,
      name,
      addTagId: HOS_LEAD_TAG_ID,
      defaultName: 'Hercules OS Lead',
    });
    if (result.ok && storage) {
      await storage.appendAuditLog({
        event_type: 'email_sync',
        entity_type: 'contact',
        entity_id: hashNormalizedEmail(email),
        action: 'lead_sync',
        result: result.mode,
        source: 'getresponse',
        redacted_error_context: null,
      }).catch(() => {});
    }
    return result;
  }

  async function syncBuyerContact({email, name}) {
    const result = await upsertGetResponseContact({
      email,
      name,
      addTagId: HOS_BUYER_TAG_ID,
      removeTagIds: [HOS_LEAD_TAG_ID, HOS_DECLINED_TAG_ID],
      defaultName: 'Hercules OS Buyer',
    });
    if (result.ok && storage) {
      await storage.appendAuditLog({
        event_type: 'email_sync',
        entity_type: 'contact',
        entity_id: hashNormalizedEmail(email),
        action: 'buyer_sync',
        result: result.mode,
        source: 'getresponse',
        redacted_error_context: null,
      }).catch(() => {});
    }
    return result;
  }

  async function syncRefundState({email, name}) {
    const result = await upsertGetResponseContact({
      email,
      name,
      addTagId: HOS_DECLINED_TAG_ID,
      removeTagIds: [HOS_BUYER_TAG_ID],
      defaultName: 'Hercules OS Refund',
    });
    if (result.ok && storage) {
      await storage.appendAuditLog({
        event_type: 'email_sync',
        entity_type: 'contact',
        entity_id: hashNormalizedEmail(email),
        action: 'refund_sync',
        result: result.mode,
        source: 'getresponse',
        redacted_error_context: null,
      }).catch(() => {});
    }
    return result;
  }

  return {
    upsertGetResponseContact,
    syncLeadContact,
    syncBuyerContact,
    syncRefundState,
  };
}

function createFulfillmentProvider({flags, fetch, env}) {
  const QUICKSTART_ACCESS_URL = env.QUICKSTART_ACCESS_URL || '';

  async function deliverAccess({sessionId, buyerEmail, buyerName, paymentIntent, leadRef, offerCode}) {
    if (!flags.enableRealFulfillment || !QUICKSTART_ACCESS_URL) return {ok: true, skipped: true};
    try {
      const res = await fetch(QUICKSTART_ACCESS_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          offer_code: offerCode,
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

  return {deliverAccess};
}

function createAnalyticsProvider({logger}) {
  return {
    capture(eventName, payload) {
      logger?.('analytics', {eventName, payload});
      return {ok: true};
    },
  };
}

module.exports = {
  createStripeProvider,
  createCRMProvider,
  createEmailProvider,
  createFulfillmentProvider,
  createAnalyticsProvider,
};
