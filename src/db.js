import pg from 'pg';

// One shared connection pool per process. DATABASE_URL is the only setting:
// a Neon URL carries its own sslmode=require, a local Docker URL doesn't
// need TLS, so no separate SSL flag is required.
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (see .env.example)');
  }
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    // Fail fast instead of letting a request hang on a stuck database.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    // Serverless Postgres (Neon) closes idle connections on its side, so
    // drop ours before that happens.
    idleTimeoutMillis: 30_000,
  });
  // Without a listener, an error on an idle pooled connection (e.g. the
  // database restarting) is an unhandled 'error' event and crashes the
  // process. The pool discards that connection and opens a new one later.
  pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', source: 'pg-pool', error: err.message }));
  });
  return pool;
}
