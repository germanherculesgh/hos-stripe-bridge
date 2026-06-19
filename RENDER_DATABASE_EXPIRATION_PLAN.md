# Render Database Expiration Plan

The staging database `hos-quickstart-postgres-staging` expires on **July 17, 2026**.

## Required Preparations

- Keep a current schema export.
- Keep a data export procedure.
- Keep a backup restore procedure.
- Plan for an upgrade or replacement database before expiration.

## Recommended Backup Steps

1. Export schema.
2. Export staging rows.
3. Verify the export can be restored.
4. Record the restore command and the target replacement database.

## Internal Warning

Treat this free database as temporary. Do not rely on it as permanent storage without a migration plan.
