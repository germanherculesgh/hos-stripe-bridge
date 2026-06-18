CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  livemode boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_status text NOT NULL,
  processed_at timestamptz,
  error_code text,
  error_message_safe text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quickstart_checkout_sessions (
  stripe_session_id text PRIMARY KEY,
  payment_intent_id text,
  stripe_customer_id text,
  internal_lead_ref text,
  buyer_email_hash text,
  offer_code text NOT NULL,
  stripe_price_id text NOT NULL,
  amount_total integer,
  currency text NOT NULL,
  payment_status text NOT NULL,
  fulfillment_status text NOT NULL,
  buyer_tag_status text NOT NULL,
  declined_tag_removal_status text NOT NULL,
  buyer_delivery_status text NOT NULL,
  toolkit_delivery_status text NOT NULL,
  refunded_at timestamptz,
  fulfilled_at timestamptz,
  last_error_code text,
  last_error_message_safe text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quickstart_checkout_sessions_payment_intent_id_idx
  ON quickstart_checkout_sessions (payment_intent_id);

CREATE INDEX IF NOT EXISTS quickstart_checkout_sessions_internal_lead_ref_idx
  ON quickstart_checkout_sessions (internal_lead_ref);

CREATE TABLE IF NOT EXISTS fulfillment_actions (
  id bigserial PRIMARY KEY,
  stripe_session_id text NOT NULL REFERENCES quickstart_checkout_sessions(stripe_session_id) ON DELETE CASCADE,
  action_type text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message_safe text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_session_id, action_type)
);

CREATE INDEX IF NOT EXISTS fulfillment_actions_session_id_idx
  ON fulfillment_actions (stripe_session_id);

CREATE INDEX IF NOT EXISTS fulfillment_actions_idempotency_key_idx
  ON fulfillment_actions (idempotency_key);
