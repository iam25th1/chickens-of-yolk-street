// Turns a postgres:// URL into libpq environment variables, so pg_dump and pg_restore connect
// without the password ever appearing on a command line or in a log.

export interface PgTarget {
  /** Environment for pg_dump / pg_restore / psql. */
  env: Record<string, string>;
  /** Database name, passed as -d (it is not a secret). */
  database: string;
  /** Host and database, safe to print. */
  label: string;
}

export function pgTarget(url: string): PgTarget {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('expected a postgres:// URL');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('the URL names no database');
  const env: Record<string, string> = { PGHOST: u.hostname, PGPORT: u.port || '5432', PGDATABASE: database };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return { env, database, label: `${u.hostname}:${env.PGPORT}/${database}` };
}

/** pg_dump file name: coys-<UTC timestamp>.dump, sortable and safe on every file system. */
export const backupName = (now: Date): string => `coys-${now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}.dump`;
