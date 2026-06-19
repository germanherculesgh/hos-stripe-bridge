# Migration and Rollback

## Migration Framework

- Script: `npm run migrate`
- Runner: `scripts/migrate-lib.js`
- Applied migrations are tracked in `schema_migrations`
- SQL files run in filename order

## Current Migration Strategy

- `001_init.sql` keeps the older bridge tables for compatibility
- `002_truth_layer.sql` adds the provider-neutral staging commerce schema
- Each migration file is transactional

## Rollback / Recovery

This repo does not currently ship an automatic down-migration runner.
Recovery procedure:

1. Stop the staging service.
2. Restore the Render Postgres backup, or
3. Drop only the staging truth-layer tables in a controlled maintenance window and rerun the migration set.

## Destructive Command Warning

Never run ad hoc destructive SQL against the live bridge service. Use backups or a maintenance-only rollback plan.
