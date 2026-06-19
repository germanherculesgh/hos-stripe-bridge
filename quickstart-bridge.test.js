const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TEST_WEBHOOK_SECRET = ['whsec', 'test', 'secret', '123'].join('_');
const TEST_PRICE_ID = 'price_test_quickstart';
const TEST_SUCCESS_URL = 'https://herculeswellness.club/start-thank-you-buyer?session_id={CHECKOUT_SESSION_ID}';
const TEST_CANCEL_URL = 'https://herculeswellness.club/start-thank-you-declined?checkout=cancelled';

const ORIGINAL_ENV = {};
for (const key of [
  'PORT',
  'DATABASE_URL',
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
  'PAYMENT_PROVIDER',
  'CRM_PROVIDER',
  'EMAIL_PROVIDER',
  'FULFILLMENT_PROVIDER',
  'CHECKOUT_MODE',
  'ENABLE_ESTATE_SYNC',
  'ENABLE_GETRESPONSE_SYNC',
  'ENABLE_REAL_FULFILLMENT',
  'STRIPE_MODE',
  'HOS_BRIDGE_STATE_DIR',
  'HOS_BRIDGE_LOG_DIR',
  'NODE_ENV',
]) {
  ORIGINAL_ENV[key] = process.env[key];
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function stripeSignature(secret, rawBody, timestamp = '1710000000') {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  });
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
      accessHits.push({method: req.method, url: req.url, body, headers: req.headers});
      res.writeHead(options.accessStatus || 200, {'content-type': 'text/plain; charset=utf-8'});
      res.end(options.accessBody || 'ok');
    });
  });
  await new Promise(resolve => accessServer.listen(0, resolve));
  const accessPort = accessServer.address().port;
  const accessUrl = `http://127.0.0.1:${accessPort}/deliver`;

  process.env.PORT = '0';
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = '';
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
  process.env.PAYMENT_PROVIDER = 'stripe';
  process.env.CRM_PROVIDER = 'estage';
  process.env.EMAIL_PROVIDER = 'getresponse';
  process.env.FULFILLMENT_PROVIDER = 'render';
  process.env.CHECKOUT_MODE = 'external';
  process.env.ENABLE_ESTATE_SYNC = 'false';
  process.env.ENABLE_GETRESPONSE_SYNC = 'false';
  process.env.ENABLE_REAL_FULFILLMENT = options.enableRealFulfillment ? 'true' : 'false';
  process.env.STRIPE_MODE = 'test';
  process.env.HOS_BRIDGE_STATE_DIR = stateDir;
  process.env.HOS_BRIDGE_LOG_DIR = logDir;

  const stripeSessions = options.stripeSessions instanceof Map
    ? new Map(options.stripeSessions)
    : new Map(Object.entries(options.stripeSessions || {}));
  const stripeRequests = [];
  const originalFetch = global.fetch;

  global.fetch = async (resource, init = {}) => {
    const url = typeof resource === 'string' ? resource : resource.url || String(resource);
    const method = (init.method || 'GET').toUpperCase();

    if (url.startsWith('https://api.stripe.com')) {
      const body = init.body ? String(init.body) : '';
      stripeRequests.push({url, method, body});
      if (url.includes('/v1/checkout/sessions') && method === 'POST') {
        return jsonResponse(options.checkoutSessionResponse || makeStripeSessionFixture({
          id: 'cs_created_123',
          url: 'https://checkout.stripe.test/cs_created_123',
          payment_status: 'unpaid',
        }), 200);
      }
      if (url.includes('/v1/checkout/sessions/') && method === 'GET') {
        const id = url.split('/v1/checkout/sessions/')[1].split('?')[0];
        const session = stripeSessions.get(id) || options.defaultStripeSession || makeStripeSessionFixture({id});
        return jsonResponse(session, 200);
      }
      return jsonResponse({error: {message: 'unexpected stripe request'}}, 500);
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
      statePath: path.join(stateDir, 'quickstart-truth-state.json'),
      accessServer,
      accessUrl,
      stripeSessions,
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

test('health endpoint exposes staging flags and storage mode', async () => {
  await withBridge({useAccessUrl: false}, async ({request}) => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.service,'hos-stripe-bridge');
    assert.equal(res.featureFlags.checkoutMode, 'external');
    assert.equal(res.envStatus.CRM_PROVIDER, 'estage');
  });
});

test('checkout endpoint uses server-side price and safe URLs', async () => {
  await withBridge(
    {
      checkoutSessionResponse: makeStripeSessionFixture({
        id: 'cs_created_999',
        url: 'https://checkout.stripe.test/cs_created_999',
        payment_status: 'unpaid',
      }),
      useAccessUrl: false,
    },
    async ({request, stripeRequests, statePath}) => {
      const res = await request('POST', '/checkout/quickstart', {
        lead_ref: 'lr_opaque_123',
        utm_source: 'test-source',
        utm_medium: 'cpc',
        utm_campaign: 'spring',
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.checkout_url, 'https://checkout.stripe.test/cs_created_999');
      assert.equal(res.json.session_id, 'cs_created_999');

      const post = stripeRequests.find(r => r.method === 'POST' && r.url.includes('/v1/checkout/sessions'));
      assert.ok(post);
      const body = new URLSearchParams(new URLSearchParams(post.body));
      assert.equal(body.get('mode'), 'payment');
      assert.equal(body.get('line_items[0][price]'), TEST_PRICE_ID);
      assert.equal(body.get('success_url'), TEST_SUCCESS_URL);
      assert.equal(body.get('cancel_url'), TEST_CANCEL_URL);

      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const order = Object.values(state.orders)[0];
      assert.equal(order.order_status, 'pending');
      assert.match(Object.keys(state.contacts)[0], /lead-.* staging\.invalid/);
    },
  );
});

test('webhook rejects invalid signatures and dedupes duplicate event ids', async () => {
  const session = makeStripeSessionFixture({
    id: 'cs_success_1',
    payment_status: 'paid',
    payment_intent: 'pi_success_1',
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_success_1', session]]),
      useAccessUrl: false,
    },
    async ({request, statePath, stripeRequests}) => {
      const event = {
        id: 'evt_success_1',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_success_1'}},
      };
      const raw = JSON.stringify(event);
      const invalid = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': 't=1,v1=deadbeef',
      });
      assert.equal(invalid.status, 400);

      const res = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, raw),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.fulfilled, true);

      const replay = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, raw),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.deduped, true);

      const secondEvent = {
        id: 'evt_success_2',
        type: 'payment_intent.succeeded',
        data: {object: {id: 'pi_success_1', customer: 'cus_test_1', amount_received: 1700, currency: 'usd'}},
      };
      const res2 = await request('POST', '/webhooks/stripe/hos-quickstart', secondEvent, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(secondEvent)),
      });
      assert.equal(res2.status, 200);

      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const order = Object.values(state.orders).find(row => row.provider_checkout_session_id === 'cs_success_1');
      assert.equal(order.order_status, 'fulfilled');
      assert.equal(Object.keys(state.fulfillmentEvents).length, 1);
      assert.equal(stripeRequests.filter(r => r.method === 'GET').length, 1);
    },
  );
});

test('payment failure and refund events update the existing order safely', async () => {
  const session = makeStripeSessionFixture({
    id: 'cs_failure_1',
    payment_status: 'paid',
    payment_intent: 'pi_failure_1',
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_failure_1', session]]),
      useAccessUrl: false,
    },
    async ({request, statePath}) => {
      const success = {
        id: 'evt_failure_success',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_failure_1'}},
      };
      await request('POST', '/webhooks/stripe/hos-quickstart', success, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(success)),
      });

      const failed = {
        id: 'evt_pi_failed',
        type: 'payment_intent.payment_failed',
        data: {object: {id: 'pi_failure_1', amount: 1700, currency: 'usd'}},
      };
      const failRes = await request('POST', '/webhooks/stripe/hos-quickstart', failed, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(failed)),
      });
      assert.equal(failRes.status, 200);

      const refund = {
        id: 'evt_refund_1',
        type: 'charge.refunded',
        data: {object: {id: 'ch_refund_1', payment_intent: 'pi_failure_1', amount: 1700, currency: 'usd'}},
      };
      const refundRes = await request('POST', '/webhooks/stripe/hos-quickstart', refund, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(refund)),
      });
      assert.equal(refundRes.status, 200);

      const replay = await request('POST', '/webhooks/stripe/hos-quickstart', refund, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(refund)),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.satus, 'deduped');

      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const order = Object.values(state.orders).find(row => row.provider_checkout_session_id === 'cs_failure_1');
      assert.equal(order.order_status, 'refunded');
      assert.equal(Object.values(state.refunds).length, 1);
    },
  );
});

test('external side effects stay disabled when staging flags are off', async () => {
  const session = makeStripeSessionFixture({
    id: 'cs_no_side_effects',
    payment_status: 'paid',
    payment_intent: 'pi_no_side_effects',
  });
  await withBridge(
    {
      stripeSessions: new Map([['cs_no_side_effects', session]]),
      useAccessUrl: false,
    },
    async ({request, stripeRequests}) => {
      const event = {
        id: 'evt_no_side_effects',
        type: 'checkout.session.completed',
        data: {object: {id: 'cs_no_side_effects'}},
      };
      const res = await request('POST', '/webhooks/stripe/hos-quickstart', event, {
        'stripe-signature': stripeSignature(TEST_WEBHOOK_SECRET, JSON.stringify(event)),
      });
      assert.equal(res.status, 200);
      assert.equal(stripeRequests.filter(r => r.url.includes('getresponse')).length, 0);
    },
  );
});
