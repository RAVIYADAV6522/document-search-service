import pg from 'pg';

// One shared connection pool per process. DATABASE_URL is the only setting:
// a Neon URL carries its own sslmode=require, a local Docker URL doesn't
// need TLS, so no separate SSL flag is required.
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (see .env.example)');
  }
  return new pg.Pool({ connectionString, max: 5 });
}
