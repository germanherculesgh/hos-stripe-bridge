const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {runMigrations} = require('../scripts/migrate-lib');

function createFakePgModule() {
  const db = {
    migrations: new Map(),
    applied: [],
  };

  function route(sql, params = []) {
    const text = String(sql).trim();
    if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return {rows: []};
    if (text.startsWith('SELECT checksum FROM schema_migrations')) {
      const row = db.migrations.get(params[0]);
      return {rows: row ? [{checksum: row.checksum}] : []};
    }
    if (text.startsWith('INSERT INTO schema_migrations')) {
      db.migrations.set(params[0], {checksum: params[1], applied_at: new Date().toISOString()});
      db.applied.push(params[0]);
      return {rows: []};
    }
    if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) return {rows: []};
    return {rows: []};
  }

  class Client {
    async query(sql, params) {
      return route(sql, params);
    }
    release() {}
  }

  class Pool {
    async query(sql, params) {
      return route(sql, params);
    }
    async connect() {
      return new Client();
    }
    async end() {}
  }

  return {Pool, __db: db};
}

test('migration runner is repeatable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hos-migrate-'));
  const migrationsDir = path.join(root, 'migrations');
  fs.mkdirSync(migrationsDir, {recursive: true});
  fs.writeFileSync(path.join(migrationsDir, '001_init.sql'), 'create table one();');

  const fakePg = createFakePgModule();
  await runMigrations({
    databaseUrl: 'postgres://example/test',
    pgModule: fakePg,
    migrationsDir,
    logger: {log() {}},
  });
  await runMigrations({
    databaseUrl: 'postgres://example/test',
    pgModule: fakePg,
    migrationsDir,
    logger: {log() {}},
  });

  assert.equal(fakePg.__db.applied.length, 1);
  assert.equal(fakePg.__db.migrations.size, 1);
});
