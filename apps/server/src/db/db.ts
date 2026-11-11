// One database interface over real Postgres (pg) and embedded Postgres (PGlite).
// DATABASE_URL picks the driver: postgres:// or postgresql:// uses pg; pglite://<dir> stores
// PGlite data in <dir>; memory:// keeps PGlite in memory (tests).
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: 'pglite' | 'postgres';
  /** Runs fn inside one transaction; any throw rolls it back. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Runs one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openDb(url: string): Promise<Db> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return openPostgres(url);
  if (url === 'memory://') return openPglite(undefined);
  if (url.startsWith('pglite://')) return openPglite(url.slice('pglite://'.length));
  throw new Error(`DATABASE_URL must start with postgres://, postgresql://, pglite:// or be memory:// (got ${url.split(':')[0]}:)`);
}

async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await pool.query('SELECT 1');
  return {
    kind: 'postgres',
    async query<T>(sql: string, params?: unknown[]) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            return (await client.query(sql, params)).rows as R[];
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(dataDir: string | undefined): Promise<Db> {
  // PGlite creates only the last directory level; make the rest (the default is .data/coys)
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const lite = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
  return {
    kind: 'pglite',
    async query<T>(sql: string, params?: unknown[]) {
      return (await lite.query<T>(sql, params)).rows;
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      return lite.transaction(async (t) =>
        fn({
          async query<R>(sql: string, params?: unknown[]) {
            return (await t.query<R>(sql, params)).rows;
          },
        }),
      );
    },
    async exec(sql: string) {
      await lite.exec(sql);
    },
    async close() {
      await lite.close();
    },
  };
}

/** pg returns int8 as strings and PGlite may return bigints; every numeric column goes through this. */
export const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
