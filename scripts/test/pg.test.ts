import { describe, expect, it } from 'vitest';
import { backupName, pgTarget } from '../lib/pg';

describe('backup and restore helpers', () => {
  it('turn a Postgres URL into libpq variables, keeping the password off the command line', () => {
    const t = pgTarget('postgres://coys%40app:p%2Fss@db.example.com:6543/yolk?sslmode=require');
    expect(t.env).toEqual({ PGHOST: 'db.example.com', PGPORT: '6543', PGDATABASE: 'yolk', PGUSER: 'coys@app', PGPASSWORD: 'p/ss', PGSSLMODE: 'require' });
    expect(t.database).toBe('yolk');
    expect(t.label).toBe('db.example.com:6543/yolk');
    expect(t.label).not.toContain('p/ss');
    expect(pgTarget('postgresql://localhost/coys').env.PGPORT).toBe('5432');
  });

  it('refuse anything but a Postgres URL with a database', () => {
    expect(() => pgTarget('pglite://.data/coys')).toThrow();
    expect(() => pgTarget('postgres://localhost/')).toThrow(/no database/);
  });

  it('name dumps by UTC time, safe on every file system', () => {
    expect(backupName(new Date(Date.UTC(2026, 10, 11, 17, 5, 9, 123)))).toBe('coys-2026-11-11T17-05-09Z.dump');
  });
});
