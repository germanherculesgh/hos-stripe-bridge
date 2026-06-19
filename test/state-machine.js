const ORDER_STATUSES = new Set([
  'created',
  'pending',
  'paid',
  'payment_failed',
  'fulfilled',
  'refunded',
  'partially_refunded',
  'canceled',
]);

const FULFILLMENT_STATUSES = new Set([
  'pending',
  'processing',
  'completed',
  'failed',
  'reversed',
]);

const ORDER_TRANSITIONS = {
  created: new Set(['pending', 'paid', 'payment_failed', 'canceled']),
  pending: new Set(['paid', 'payment_failed', 'canceled']),
  paid: new Set(['fulfilled', 'refunded', 'partially_refunded', 'canceled']),
  payment_failed: new Set(['pending', 'canceled']),
  fulfilled: new Set(['refunded', 'partially_refunded']),
  refunded: new Set([]),
  partially_refunded: new Set(['refunded']),
  canceled: new Set([]),
};

const FULFILLMENT_TRANSITIONS = {
  pending: new Set(['processing', 'failed', 'reversed']),
  processing: new Set(['completed', 'failed', 'reversed']),
  completed: new Set(['reversed']),
  failed: new Set(['pending', 'processing']),
  reversed: new Set([]),
};

function normalizeOrderStatus(value, fallback = 'created') {
  const status = String(value || fallback || '').toLowerCase();
  return ORDER_STATUSES.has(status) ? status : fallback;
}

function normalizeFulfillmentStatus(value, fallback = 'pending') {
  const status = String(value || fallback || '').toLowerCase();
  return FULFILLMENT_STATUSES.has(status) ? status : fallback;
}

function canTransition(map, from, to) {
  const fromStatus = String(from || '').toLowerCase();
  const toStatus = String(to || '').toLowerCase();
  if (fromStatus === toStatus) return true;
  return Boolean(map[fromStatus] && map[fromStatus].has(toStatus));
}

function assertOrderTransition(from, to) {
  const next = normalizeOrderStatus(to, from || 'created');
  if (!canTransition(ORDER_TRANSITIONS, from, next)) {
    throw new Error(`invalid order transition: ${from} -> ${next}`);
  }
  return next;
}

function assertFulfillmentTransition(from, to) {
  const next = normalizeFulfillmentStatus(to, from || 'pending');
  if (!canTransition(FULFILLMENT_TRANSITIONS, from, next)) {
    throw new Error(`invalid fulfillment transition: ${from} -> ${next}`);
  }
  return next;
}

module.exports = {
  ORDER_STATUSES,
  FULFILLMENT_STATUSES,
  ORDER_TRANSITIONS,
  FULFILLMENT_TRANSITIONS,
  normalizeOrderStatus,
  normalizeFulfillmentStatus,
  assertOrderTransition,
  assertFulfillmentTransition,
};
