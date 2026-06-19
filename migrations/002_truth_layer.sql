CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  phone text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  product_reference text NOT NULL,
  provider text NOT NULL,
  provider_checkout_session_id text,
  provider_order_id text,
  currency text NOT NULL,
  amount integer NOT NULL,
  order_status text NOT NULL DEFAULT 'created',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_provider_checkout_session_id_unique UNIQUE (provider, provider_checkout_session_id),
  CONSTRAINT orders_provider_order_id_unique UNIQUE (provider, provider_order_id)
);

CREATE INDEX IF NOT EXISTS orders_contact_id_idx ON orders (contact_id);
CREATE INDEX IF NOT EXISTS orders_provider_idx ON orders (provider);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_customer_id text,
  payment_intent_id text,
  charge_id text,
  amount integer NOT NULL,
  currency text NOT NULL,
  payment_status text NOT NULL DEFAULT 'pending',
  test_mode boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_payment_intent_id_unique UNIQUE (provider, payment_intent_id),
  CONSTRAINT payments_charge_id_unique UNIQUE (provider, charge_id)
);

CREATE INDEX IF NOT EXISTS payments_order_id_idx ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_provider_idx ON payments (provider);

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  processing_status text NOT NULL DEFAULT 'processing',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 1,
  last_error text,
  payload_ref text,
  safe_metadata jsonb,
  livemode boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_events_processing_status_idx ON payment_events (processing_status);
CREATE INDEX IF NOT EXISTS payment_events_event_type_idx ON payment_events (event_type);

CREATE TABLE IF NOT EXISTS refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider_refund_id text NOT NULL UNIQUE,
  amount integer NOT NULL,
  currency text NOT NULL,
  refund_status text NOT NULL DEFAULT 'pending',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refunds_payment_id_idx ON refunds (payment_id);

CREATE TABLE IF NOT EXISTS fulfillment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  fulfillment_type text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL UNIQUE,
  attempt_count integer NOT NULL DEFAULT 1,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fulfillment_events_order_id_idx ON fulfillment_events (order_id);
CREATE INDEX IF NOT EXISTS fulfillment_events_provider_idx ON fulfillment_events (provider);

CREATE TABLE IF NOT EXISTS provider_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_links_provider_external_id_unique UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS provider_links_entity_idx ON provider_links (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  result text NOT NULL,
  source text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now(),
  redacted_error_context jsonb
);

CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON audit_logs (timestamp DESC);
