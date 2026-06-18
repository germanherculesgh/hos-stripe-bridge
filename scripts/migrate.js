const {runMigrations} = require('./migrate-lib');

runMigrations({
  databaseUrl: process.env.DATABASE_URL || '',
}).catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});
