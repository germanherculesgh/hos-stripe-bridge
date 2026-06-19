const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

async function runMigrations({
  databaseUrl,
  pgModule,
  migrationsDir = path.join(__dirname, '..', 'migrations'),
  sslMode = process.env.DATABASE_SSL_MODE || '',
  poolMax = Number(process.env.DATABASE_POOL_MAX || 5),
  logger = console,
} = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const {Pool} = pgModule || require('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: String(sslMode || '').toLowerCase() === 'disable' ? false : {rejectUnauthorized: false},
    max: poolMax,
  });

  const files = fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    const existing = await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name = $1', [file]);
    if (existing.rows[0]?.checksum === checksum) {
      logger.log?.(`migration ${file} already applied`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `
        INSERT INTO schema_migrations (migration_name, checksum, applied_at)
        VALUES ($1, $2, now())
        ON CONFLICT (migration_name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = EXCLUDED.applied_at
        `,
        [file, checksum],
      );
      await client.query('COMMIT');
      logger.log?.(`applied migration ${file}`);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

module.exports = {runMigrations};
