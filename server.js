const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
const STRIPE_PAYMENT_LINK_ID = process.env.STRIPE_PAYMENT_LINK_ID || 'plink_1TcIvYDfPgr5wAVlitvX7U2C';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const ALLOWED_ORIGINS = new Set([
  'https://herculeswellness.club',
  'https://www.herculeswellness.club',
  'https://my-web-1696084750836.estage.com',
]);
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

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
function send(res, status, body, type='application/json; charset=utf-8', extraHeaders={}) {
  res.writeHead(status, {'content-type': type, ...extraHeaders});
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}
function log(kind, data) {
  fs.appendFileSync(path.join(LOG_DIR, kind + '.jsonl'), JSON.stringify({at:new Date().toISOString(), ...data})+'\n');
}
function readRaw(req) {
  return new Promise((resolve,reject)=>{const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject);});
}
async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}
function verifyStripeSignature(raw, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET) return {ok:true, skipped:true};
  if (!sigHeader) return {ok:false, reason:'missing stripe-signature'};
  const parts = Object.fromEntries(sigHeader.split(',').map(p=>{const [k,v]=p.split('='); return [k,v];}));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return {ok:false, reason:'malformed stripe-signature'};
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
function normalizeLead(input) {
  const firstName = String(input.firstName || input.first_name || input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const phone = String(input.phone || '').trim();
  return {email, name: firstName || 'Hercules OS Lead', phone, source: String(input.source || 'hercules_os_start').slice(0, 80)};
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function uniqueTags(existingTags, tagId) {
  const ids = new Set((existingTags || []).map(t => t && t.tagId).filter(Boolean));
  ids.add(tagId);
  return [...ids].map(id => ({tagId:id}));
}
async function upsertGetResponseContact({email, name, tagId, defaultName}) {
  const headers = {'Content-Type':'application/json','X-Auth-Token':`api-key ${GETRESPONSE_API_KEY}`};
  const queryUrl = `${GETRESPONSE_BASE_URL}/contacts?query[email]=${encodeURIComponent(email)}`;
  const existingRes = await fetch(queryUrl, {headers});
  const existingText = await existingRes.text();
  let existing=[]; try { existing = JSON.parse(existingText); } catch {}
  if (Array.isArray(existing) && existing[0]?.contactId) {
    const contactId = existing[0].contactId;
    const patchBody = {
      name: name || existing[0].name || defaultName,
      campaign:{campaignId:HOS_CAMPAIGN_ID},
      tags: uniqueTags(existing[0].tags, tagId),
    };
    const patch = await fetch(`${GETRESPONSE_BASE_URL}/contacts/${contactId}`, {method:'POST', headers, body:JSON.stringify(patchBody)});
    const body = await patch.text();
    return {mode:'update', contactId, status:patch.status, ok:patch.ok, body};
  }
  const create = await fetch(`${GETRESPONSE_BASE_URL}/contacts`, {method:'POST', headers, body:JSON.stringify({email, name:name||defaultName, campaign:{campaignId:HOS_CAMPAIGN_ID}, tags:[{tagId}], dayOfCycle:'0'})});
  const body = await create.text();
  return {mode:'create', status:create.status, ok:create.ok || create.status===202, body};
}
async function upsertBuyerContact({email, name}) {
  return upsertGetResponseContact({email, name, tagId:HOS_BUYER_TAG_ID, defaultName:'Hercules OS Buyer'});
}
async function upsertLeadContact({email, name}) {
  return upsertGetResponseContact({email, name, tagId:HOS_LEAD_TAG_ID, defaultName:'Hercules OS Lead'});
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain; charset=utf-8', corsHeaders(req));
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, {ok:true, service:'hos-stripe-bridge', campaignId:HOS_CAMPAIGN_ID, leadTagId:HOS_LEAD_TAG_ID, buyerTagId:HOS_BUYER_TAG_ID, paymentLinkId:STRIPE_PAYMENT_LINK_ID, signatureVerification: Boolean(STRIPE_WEBHOOK_SECRET), getResponseConfigured: Boolean(GETRESPONSE_API_KEY)}, 'application/json; charset=utf-8', corsHeaders(req));
  if (req.method === 'POST' && url.pathname === '/leads/hos-start') {
    try {
      const lead = normalizeLead(await readJson(req));
      if (!validEmail(lead.email)) return send(res, 400, {ok:false, error:'valid email required'}, 'application/json; charset=utf-8', corsHeaders(req));
      log('lead-events', {lead:{email:lead.email, name:lead.name, hasPhone:Boolean(lead.phone), source:lead.source}});
      const gr = await upsertLeadContact(lead);
      log('lead-results', {lead:{email:lead.email, name:lead.name, source:lead.source}, gr});
      return send(res, gr.ok ? 200 : 502, {ok:gr.ok, lead:{email:lead.email, name:lead.name, source:lead.source}, getresponse:gr}, 'application/json; charset=utf-8', corsHeaders(req));
    } catch(e) {
      log('errors',{route:'leads/hos-start',error:e.stack||String(e)});
      return send(res, 500, {ok:false,error:e.message}, 'application/json; charset=utf-8', corsHeaders(req));
    }
  }
  if (req.method === 'POST' && url.pathname === '/webhooks/stripe/hos-quickstart') {
    const raw = await readRaw(req);
    const sig = verifyStripeSignature(raw, req.headers['stripe-signature']);
    if (!sig.ok) { log('stripe-rejected',{reason:sig.reason}); return send(res, 400, {ok:false, error:sig.reason}); }
    let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch(e) { return send(res,400,{ok:false,error:'invalid json'}); }
    const buyer = pickBuyer(evt);
    log('stripe-events', {eventId: evt.id, buyer});
    const eligible = evt.type === 'checkout.session.completed' && buyer.email && (!buyer.paymentLink || buyer.paymentLink === STRIPE_PAYMENT_LINK_ID);
    if (!eligible) return send(res, 200, {ok:true, skipped:true, buyer});
    try {
      const gr = await upsertBuyerContact(buyer);
      log('getresponse-results', {eventId: evt.id, buyer, gr});
      return send(res, gr.ok ? 200 : 502, {ok:gr.ok, buyer, getresponse:gr});
    } catch(e) { log('errors',{eventId:evt.id,error:e.stack||String(e)}); return send(res,500,{ok:false,error:e.message}); }
  }
  send(res,404,{ok:false,error:'not found'}, 'application/json; charset=utf-8', corsHeaders(req));
});
server.listen(PORT,()=>console.log(`HOS Stripe bridge listening on http://127.0.0.1:${PORT}`));
