const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ORIGINAL_ENV = {};
for (const key of [
  'PORT',
  'GETRESPONSE_API_KEY',
  'GETRESPONSE_BASE_URL',
  'HOS_GETRESPONSE_CAMPAIGN_ID',
  'HOS_BUYER_TAG_ID',
  'HOS_LEAD_TAG_ID',
  'HOS_DECLINED_TAG_ID',
  'STRIPE_PAYMENT_LINK_ID',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_QUICKSTART_PRICE_ID',
  'QUICKSTART_SUCCESS_URL',
  'QUICKSTART_CANCEL_URL',
  'QUICKSTART_ACCESS_URL',
  'STRIPE_ENVIRONMENT',
  'HOS_BRIDGE_STATE_DIR',
  'HOS_BRIDGE_LOG_DIR',
]) {
  ORIGINAL_ENV[key] = process.env[key];
}

const TEST_WEBHOOK_SECRET = ['whsec', 'test', 'secret', '123'].join('_');
const TEST_PRICE_ID = 'price_test_quickstart';
const TEST_ACCESS_URL_TEMPLATE = 'http://127.0.0.1:PORT/deliver';
const TEST_SUCCESS_URL = 'https://herculeswellness.club/start-thank-you-buyer?session_id={CHECKOUT_SESSION_ID}';
const TEST_CANCEL_URL = 'https://herculeswellness.club/start-thank-you-declined?checkout=cancelled';

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  });
}

function stripeSignature(secret, rawBody, timestamp = '1710000000') {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

async function readJsonBody(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function makeStripeSessionFixture(overrides = {}) {
  return {
    id: 'cs_test_123',
    url: 'https://checkout.stripe.test/cs_test_123',
    mode: 'payment',
    amount_total: 1700,
    currency: 'usd',
    payment_status: 'unpaid',
    payment_intent: 'pi_test_123',
    customer_details: {email: 'buyer@example.com', name: 'Buyer Name'},
    client_reference_id: 'lr_test_123',
    metadata: {
      offer_code: 'HOS_QUICKSTART_V3',
      price_id: TEST_PRICE_ID,
      lead_ref: 'lr_test_123',
    },
    line_items: {
      data: [
        {
          price: {id: TEST_PRICE_ID},
        },
      ],
    },
    ...overrides,
  };
}

async function withBridge(options, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hos-bridge-'));
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(stateDir, {recursive: true});
  fs.mkdirSync(logDir, {recursive: true});

  const accessHits = [];
  const accessServer = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      accessHits.push({
        method: req.method,
        url: req.url,
        body,
        headers: req.headers,
      });
      res.writeHead(options.accessStatus || 200, {'content-type': 'text/plain; charset=utf-8'});
      res.end(options.accessBody || 'ok');
    });
  });
  await new Promise(resolve => accessServer.listen(0, resolve));
  const accessPort = accessServer.address().port;
  const accessUrl = (options.accessUrlTemplate || TEST_ACCESS_URL_TEMPLATE).replace('PORT', String(accessPort));

  process.env.PORT = '0';
  process.env.GETRESPONSE_API_KEY = 'gr_test_key';
  process.env.GETRESPONSE_BASE_URL = 'https://api.getresponse.com/v3';
  process.env.HOS_GETRESPONSE_CAMPAIGN_ID = 'f12ji';
  process.env.HOS_BUYER_TAG_ID = 'buyer_tag';
  process.env.HOS_LEAD_TAG_ID = 'lead_tag';
  process.env.HOS_DECLINED_TAG_ID = 'declined_tag';
  process.env.STRIPE_PAYMENT_LINK_ID = 'plink_test_old';
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = ['sk', 'test', 'placeholder'].join('_');
  process.env.STRIPE_QUICKSTART_PRICE_ID = TEST_PRICE_ID;
  process.env.QUICKSTART_SUCCESS_URL = TEST_SUCCESS_URL;
  process.env.QUICKSTART_CANCEL_URL = TEST_CANCEL_URL;
  process.env.QUICKSTART_ACCESS_URL = options.useAccessUrl === false ? '' : accessUrl;
  process.env.STRIPE_ENVIRONMENT = 'test';
  process.env.HOS_BRIDGE_STATE_DIR = stateDir;
  process.env.HOS_BRIDGE_LOG_DIR = logDir;

  const stripeSessions = options.stripeSessions instanceof Map
    ? new Map(options.stripeSessions)
    : new Map(Object.entries(options.stripeSessions || {}));
  const stripeRequests = [];
  const getresponseRequests = [];
  const originalFetch = global.fetch;

  global.fetch = async (resource, init = {}) => {
    const url = typeof resource === 'string' ? resource : resource.url || String(resource);
    const method = (init.method || 'GET').toUpperCase();

    if (url.startsWith('https://api.stripe.com')) {
      const body = init.body ? String(init.body) : '';
      stripeRequests.push({url, method, body});
      if (url.includes('/v1/checkout/sessions') && method === 'POST') {
        const session = options.checkoutSessionResponse || makeStripeSessionFixture({
          id: 'cs_created_123',
          url: 'https://checkout.stripe.test/cs_created_123',
          payment_status: 'unpaid',
        });
        return jsonResponse(session, 200);
      }
      if (url.includes('/v1/checkout/sessions/') && method === 'GET') {
        const id = url.split('/v1/checkout/sessions/')[1].split('?')[0];
        const session = stripeSessions.get(id) || options.defaultStripeSession || makeStripeSessionFixture({id});
        if (!session) return jsonResponse({error: {message: 'not found'}}, 404);
        return jsonResponse(session, 200);
      }
      return jsonResponse({error: {message: 'unexpected stripe request'}}, 500);
    }

    if (url.startsWith('https://api.getresponse.com')) {
      const body = init.body ? String(init.body) : '';
      getresponseRequests.push({url, method, body});
      if (method === 'GET' && url.includes('/contacts?query[email]=')) {
        return jsonResponse(options.getresponseExistingContacts || [], 200);
      }
      if (method === 'POST' && url.includes('/contacts/')) {
        if (options.getresponseUpdateStatus === 0) return jsonResponse({error: 'update failed'}, 500);
        return jsonResponse({ok: true}, options.getresponseUpdateStatus || 200);
      }
      if (method === 'POST' && url.endsWith('/contacts')) {
        if (options.getresponseCreateStatus === 0) return jsonResponse({error: 'create failed'}, 500);
        return jsonResponse({ok: true}, options.getresponseCreateStatus || 202);
      }
      return jsonResponse({error: {message: 'unexpected getresponse request'}}, 500);
    }

    return originalFetch(resource, init);
  };

  delete require.cache[require.resolve('../server.js')];
  const bridge = require('../server.js');
  await new Promise(resolve => bridge.server.listen(0, resolve));
  const bridgePort = bridge.server.address().port;
  const baseUrl = `http://127.0.0.1:${bridgePort}`;

async function request(method, pathname, body, headers = {}) {
    const res = await originalFetch(`${baseUrl}${pathname}`, {
      method,
      headers: body ? {'content-type': 'application/json', ...headers} : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return {status: res.status, text, json: text ? JSON.parse(text) : {}};
  }

  try {
    await fn({
      bridge,
      request,
      baseUrl,
      accessHits,
      stripeRequests,
      getresponseRequests,
      statePath: path.join(stateDir, 'quickstart-stripe-state.json'),
      accessServer,
      accessUrl,
      stripeSessions,
      defaultStripeSession: options.defaultStripeSession || makeStripeSessionFixture(),
    });
  } finally {
    await new Promise(resolve => bridge.server.close(resolve)).catch(() => {});
    await new Promise(resolve => accessServer.close(resolve)).catch(() => {});
    global.fetch = originalFetch;
    delete require.cache[require.resolve('../server.js')];
    fs.rmSync(root, {recursive: true, force: true});
    restoreEnv();
  }
}

test('checkout endpoint uses fixed server-side price, URLs, and offer metadata', async () => {
  await withBridge(
    {
      checkoutSessionResponse: makeStripeSessionFixture({
        id: 'cs_created_999',
        url: 'https://checkout.stripe.test/cs_created_999',
        payment_status: 'unpaid',
      }),
      useAccessUrl: false,
    },
    async ({request, stripeRequests}) => {
      const res = await request('POST', '/checkout/quickstart', {
        lead_ref: 'lr_opaque_123',
        utm_source: 'test-source',
        utm_medium: 'cpc',
        utm_campaign: 'spring',
        utm_content: 'cta-a',
        utm_term: 'quickstart',
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.checkout_url, 'https://checkout.stripe.test/cs_created_999');
      assert.equal(res.json.session_id, 'cs_created_999');

      const post = stripeRequests.find(r => r.method === 'POST' && r.url.includes('/v1/checkout/sessions'));
      assert.ok(post);
      const body = new URLSearchParams(post.body);
      assert.equal(body.get('mode'), 'payment');
      assert.equal(body.get('line_items[0][price]'), TEST_PRICE_ID);
      assert.equal(body.get('line_items[0][quantity]'), '1');
      assert.equal(body.get('success_url'), TEST_SUCCESS_URL);
      assert.equal(body.get('cancel_url'), TEST_CANCEL_URL);
      assert.equal(body.get('client_reference_id'), 'lr_opaque_123');
      assert.equal(body.get('metadata[offer_code]'), 'HOS_QUICKSTART_V3');
      assert.equal(body.get('metadata[price_id]'), TEST_PRICE_ID);
      assert.equal(body.get('payment_intent_data[metadata][price_id]'), TEST_PRICE_ID);
    },
  );
});

test('checkout endpoint rejects malformed or tampered input', async () => {
  await withBridge({useAccessUrl: false}, async ({request}) => {
    const res = await request('POST', '/checkout/quickstart', {
      lead_ref: 'lr_opaque_123',
      price_id: 'evil',
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /unknown field/);
  });
});

test('status endpoint returns sanitized information only', async () => {
  const paidSession = makeStripeSessionFixture({
    id: 'cs_status_1',
    payment_status: 'paid',
    customer_details: {email: 'secret@example.com', name: 'Secret Name'},
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_status_1', paidSession]]),
      useAccessUrl: false,
      defaultStripeSession: paidSession,
    },
    async ({request}) => {
      const res = await request('GET', '/checkout/session-status?session_id=cs_status_1');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, {
        session_id: 'cs_status_1',
        offer: 'HOS_QUICKSTART_V3',
        payment_status: 'paid',
        fulfillment_status: 'pending',
        amount_total: 1700,
        currency: 'usd',
      });
      assert.equal('customer_email' in res.json, false);
      assert.equal('metadata' in res.json, false);
    },
  );
});

test('webhook rejects unsigned events', async () => {
  await withBridge({useAccessUrl: false}, async ({request}) => {
    const body = JSON.stringify({
      id: 'evt_unsigned',
      type: 'checkout.session.completed',
      data: {object: {id: 'cs_nope'}},
    });
    const res = await request('POST', '/webhooks/stripe/hos-quickstart', JSON.parse(body));
    assert.equal(res.status, 400);
    assert.match(res.json.error, /missing stripe-signature|malformed stripe-signature/);
  });
});

test('successful fulfillment applies buyer tag, removes declined tag, and triggers toolkit delivery', async () => {
  const session = makeStripeSessionFixture({
    id: 'cs_success_1',
    payment_status: 'paid',
    payment_intent: 'pi_success_1',
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_success_1', session]]),
      getresponseExistingContacts: [
        {
          contactId: 'gr_1',
          name: 'Existing Buyer',
          tags: [{tagId: 'declined_tag'}, {tagId: 'lead_tag'}],
        },
      ],
      useAccessUrl: true,
    },
    async ({request, accessHits, getresponseRequests, statePath}) => {
      const event = {
        id: 'evt_success_1',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_success_1'}},
      };
      const raw = JSON.stringify(event);
      const res = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, raw),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.fulfilled, true);

      const patch = getresponseRequests.find(r => r.method === 'POST' && r.url.includes('/contacts/gr_1'));
      assert.ok(patch);
      const patchBody = JSON.parse(patch.body);
      assert.deepEqual(
        patchBody.tags,
        [{tagId: 'buyer_tag'}],
        'buyer tag should replace declined and lead tags',
      );

      assert.equal(accessHits.length, 1);
      const accessPayload = JSON.parse(accessHits[0].body);
      assert.equal(accessPayload.offer_code, 'HOS_QUICKSTART_V3');
      assert.equal(accessPayload.session_id, 'cs_success_1');
      assert.equal(accessPayload.payment_intent, 'pi_success_1');

      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.fulfillment.cs_success_1.status, 'fulfilled');
      assert.equal(state.fulfillment.cs_success_1.sequence_state, 'buyer');
    },
  );
});

test('toolkit delivery failure blocks successful fulfillment', async () => {
  const session = makeStripeSessionFixture({
    id: 'cs_delivery_fail',
    payment_status: 'paid',
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_delivery_fail', session]]),
      getresponseExistingContacts: [{contactId: 'gr_1', tags: []}],
      accessStatus: 500,
      useAccessUrl: true,
    },
    async ({request, statePath}) => {
      const event = {
        id: 'evt_delivery_fail',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_delivery_fail'}},
      };
      const raw = JSON.stringify(event);
      const res = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, raw),
      });
      assert.equal(res.status, 502);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.fulfillment.cs_delivery_fail.status, 'partial_failure');
      assert.equal(state.fulfillment.cs_delivery_fail.reason, 'toolkit_delivery_failed');
    },
  );
});

test('wrong amount, wrong currency, and unpaid sessions are handled safely', async () => {
  await withBridge(
    {
      stripeSessions: new Map([
        ['cs_wrong_amount', makeStripeSessionFixture({id: 'cs_wrong_amount', amount_total: 1000, payment_status: 'paid'})],
        ['cs_wrong_currency', makeStripeSessionFixture({id: 'cs_wrong_currency', currency: 'eur', payment_status: 'paid'})],
        ['cs_unpaid', makeStripeSessionFixture({id: 'cs_unpaid', payment_status: 'unpaid'})],
      ]),
      getresponseExistingContacts: [{contactId: 'gr_1', tags: []}],
      useAccessUrl: false,
    },
    async ({request, statePath}) => {
      const wrongAmount = {
        id: 'evt_wrong_amount',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_wrong_amount'}},
      };
      let res = await request('POST', '/webhooks/stripe/hos-quickstart', wrongAmount, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(wrongAmount)),
      });
      assert.equal(res.status, 502);

      const wrongCurrency = {
        id: 'evt_wrong_currency',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_wrong_currency'}},
      };
      res = await request('POST', '/webhooks/stripe/hos-quickstart', wrongCurrency, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(wrongCurrency)),
      });
      assert.equal(res.status, 502);

      const unpaid = {
        id: 'evt_unpaid',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_unpaid'}},
      };
      res = await request('POST', '/webhooks/stripe/hos-quickstart', unpaid, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(unpaid)),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.pending, true);

      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.fulfillment.cs_wrong_amount.status, 'failed');
      assert.equal(state.fulfillment.cs_wrong_currency.status, 'failed');
      assert.equal(state.fulfillment.cs_unpaid.status, 'pending');
    },
  );
});

test('duplicate events and duplicate sessions do not repeat fulfillment', async () => {
  const session = makeStripeSessionFixture({
    id: 'cs_dedupe',
    payment_status: 'paid',
    payment_intent: 'pi_dedupe',
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_dedupe', session]]),
      getresponseExistingContacts: [{contactId: 'gr_1', tags: []}],
      useAccessUrl: true,
    },
    async ({request, accessHits, getresponseRequests, statePath}) => {
      const event = {
        id: 'evt_dedupe_1',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_dedupe'}},
      };
      const raw = JSON.stringify(event);
      let res = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, raw),
      });
      assert.equal(res.status, 200);

      res = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, raw),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.deduped, true);

      const event2 = {
        id: 'evt_dedupe_2',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_dedupe'}},
      };
      res = await request('POST', '/webhooks/stripe/hos-quickstart', event2, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(event2)),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.deduped, true);

      const patches = getresponseRequests.filter(r => r.method === 'POST' && r.url.includes('/contacts/gr_1'));
      assert.equal(patches.length, 1);
      assert.equal(accessHits.length, 1);

      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.fulfillment.cs_dedupe.status, 'fulfilled');
    },
  );
});

test('async payment success and refund handling are recorded', async () => {
  const session = makeStripeSessionFixture({
    id: 'cs_async',
    payment_status: 'paid',
    payment_intent: 'pi_async',
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_async', session]]),
      getresponseExistingContacts: [{contactId: 'gr_1', tags: []}],
      useAccessUrl: false,
    },
    async ({request, statePath}) => {
      const asyncSuccess = {
        id: 'evt_async_success',
        type: 'checkout.session.async_payment_succeeded',
        data: {object: {id: 'cs_async'}},
      };
      let res = await request('POST', '/webhooks/stripe/hos-quickstart', asyncSuccess, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(asyncSuccess)),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.fulfilled, true);

      const refund = {
        id: 'evt_refund_1',
        type: 'charge.refunded',
        data: {object: {id: 'ch_refund_1', payment_intent: 'pi_async'}},
      };
      res = await request('POST', '/webhooks/stripe/hos-quickstart', refund, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(refund)),
      });
      assert.equal(res.status, 200);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.fulfillment.cs_async.status, 'failed');
      assert.equal(state.fulfillment.cs_async.reason, 'refunded');
    },
  );
});

test('direct buyer-page visits do not trigger fulfillment', async () => {
  await withBridge({useAccessUrl: false}, async ({request, statePath}) => {
    const res = await request('GET', '/start-thank-you-buyer?session_id=cs_fake');
    assert.equal(res.status, 404);
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.deepEqual(state.fulfillment || {}, {});
    } else {
      assert.equal(fs.existsSync(statePath), false);
    }
  });
});
