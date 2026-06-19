function boolFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function stringFlag(value, defaultValue = '') {
  const normalized = String(value ?? '').trim();
  return normalized || defaultValue;
}

function loadFeatureFlags(env = process.env) {
  return {
    paymentProvider: stringFlag(env.PAYMENT_PROVIDER, 'stripe'),
    crmProvider: stringFlag(env.CRM_PROVIDER, 'estage'),
    emailProvider: stringFlag(env.EMAIL_PROVIDER, 'getresponse'),
    fulfillmentProvider: stringFlag(env.FULFILLMENT_PROVIDER, 'render'),
    checkoutMode: stringFlag(env.CHECKOUT_MODE, 'external'),
    enableEstateSync: boolFlag(env.ENABLE_ESTATE_SYNC, false),
    enableGetResponseSync: boolFlag(env.ENABLE_GETRESPONSE_SYNC, false),
    enableRealFulfillment: boolFlag(env.ENABLE_REAL_FULFILLMENT, false),
    stripeMode: stringFlag(env.STRIPE_MODE, 'test'),
  };
}

module.exports = {boolFlag, stringFlag, loadFeatureFlags};
