-- One heartbeat run → at most one cost_events row, enforced by the database.
-- Replaces the non-unique btree index (lookups stay covered by the unique index
-- for non-null heartbeat_run_id). Partial WHERE keeps null heartbeat_run_id
-- rows insertable more than once (non-run ledger events).
DROP INDEX IF EXISTS "cost_events_company_heartbeat_run_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_company_heartbeat_run_uq" ON "cost_events" USING btree ("company_id","heartbeat_run_id") WHERE "heartbeat_run_id" IS NOT NULL;
