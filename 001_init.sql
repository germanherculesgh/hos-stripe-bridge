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
