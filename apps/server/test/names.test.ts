// Farm names in the game: a new email player gets a generated name and is asked to choose; the
// choice follows the rules (unique in the season, not the email name, not rude) and the first one
// is free, then a rename waits a week; farms named at sign-in before farm naming are renamed at
// boot, their old name gone from the player row and from recorded trades.
import { describe, expect, it } from 'vitest';
import { ECONOMY, nameLetters } from '@coys/shared';
import { nameGuardOf, renameLegacyFarms, sha256Hex } from '../src/game/names';
import { makeGame } from './helpers';

const guardFor = (emailName: string) => ({ sha256: sha256Hex(nameLetters(emailName)), len: nameLetters(emailName).length });

describe('farm names', () => {
  it('a new email player gets a generated name and chooses one under the rules', async () => {
    const t = await makeGame({ cast: true });
    const p = await t.game.ensurePlayer('privy', 'did:privy:cm0ccc333', null, guardFor('henny.penny'));
    const state = await t.game.getFarmState(p.farmId);
    expect(state.needsName).toBe(true);
    expect(state.name).toMatch(/^[A-Za-z][A-Za-z ']+$/);
    const tryName = (name: string) => t.game.act(p.playerId, { t: 'setFarmName', rid: `n-${name}`, name });
    expect(await tryName('Henny Penny Acres')).toMatchObject({ ok: false, code: 'name_email' });
    expect(await tryName('HENNYPENNY')).toMatchObject({ ok: false, code: 'name_email' });
    const agent = (await t.db.query<{ name: string }>(`SELECT name FROM farms WHERE owner_kind = 'agent' LIMIT 1`))[0]?.name ?? '';
    expect(await tryName(agent.toUpperCase())).toMatchObject({ ok: false, code: 'name_taken' });
    expect(await tryName('Fuck Farm')).toMatchObject({ ok: false, code: 'name_rude' });
    expect(await tryName('x')).toMatchObject({ ok: false, code: 'name_length' });
    expect(await tryName('  Cluckingham   Acres ')).toMatchObject({ ok: true });
    let s = await t.game.getFarmState(p.farmId);
    expect([s.name, s.needsName, s.renameFromDay]).toEqual(['Cluckingham Acres', false, null]);
    // a rename in Settings: allowed now, then not for an in-game week
    expect(await tryName('Yolkshire Roost')).toMatchObject({ ok: true });
    s = await t.game.getFarmState(p.farmId);
    expect(s.renameFromDay).toBe(s.day + 7);
    expect(await tryName('Wattle Nook')).toMatchObject({ ok: false, code: 'name_wait' });
    for (let i = 0; i < 7; i++) {
      t.clock.t += ECONOMY.day.lengthMs;
      await t.game.endDay();
    }
    expect(await tryName('Wattle Nook')).toMatchObject({ ok: true });
    // the board shows the farm name; the player row holds it too, not anything from sign-in
    expect((await t.game.getMarketState()).ranking.some((r) => r.name === 'Wattle Nook')).toBe(true);
    const [row] = await t.db.query(`SELECT display_name, name_guard_sha256 FROM players WHERE id = $1`, [p.playerId]);
    expect(row?.display_name).toBe('Wattle Nook');
    expect(row?.name_guard_sha256).toBe(guardFor('henny.penny').sha256);
    await t.db.close();
  });

  it('skipping the naming screen keeps the generated name', async () => {
    const t = await makeGame();
    const p = await t.game.ensurePlayer('privy', 'did:privy:cm0ddd444', null, null);
    const before = await t.game.getFarmState(p.farmId);
    await t.game.act(p.playerId, { t: 'keepFarmName', rid: 'k' });
    const after = await t.game.getFarmState(p.farmId);
    expect([after.name, after.needsName]).toEqual([before.name, false]);
    await t.db.close();
  });

  it('the local dev login keeps a typed name that passes the rules, and generates one otherwise', async () => {
    const t = await makeGame();
    const a = await t.game.ensurePlayer('dev', 'device-00000001', 'Ada');
    const b = await t.game.ensurePlayer('dev', 'device-00000002', 'Ada');
    const c = await t.game.ensurePlayer('dev', 'device-00000003', 'me@example.com');
    expect((await t.game.getFarmState(a.farmId)).name).toBe('Ada');
    expect((await t.game.getFarmState(a.farmId)).needsName).toBe(false);
    expect((await t.game.getFarmState(b.farmId)).name).not.toBe('Ada');
    expect((await t.game.getFarmState(c.farmId)).name).not.toContain('@');
    await t.db.close();
  });

  it('farms named at sign-in before farm naming are renamed at boot, and their old name leaves trades', async () => {
    const t = await makeGame();
    const p = await t.game.ensurePlayer('privy', 'did:privy:cm0eee555', null, null);
    // as such a farm was: named after the email name, with a trade recorded under it
    await t.db.query(`UPDATE farms SET name = $2, name_source = 'legacy', needs_name = false WHERE id = $1`, [p.farmId, "zorbly.k's Farm"]);
    await t.db.query(`UPDATE players SET display_name = 'zorbly.k', name_guard_sha256 = NULL WHERE id = $1`, [p.playerId]);
    await t.db.query(
      `INSERT INTO trades (day, at, seller, seller_farm, buyer, buyer_farm, grade, qty, price_milli, total_milli, via) VALUES (1, 0, $2, $1, 'The Market', NULL, 'white', 1, 1000, 1000, 'street')`,
      [p.farmId, "zorbly.k's Farm"],
    );
    expect(await t.db.tx((q) => renameLegacyFarms(q))).toBe(1);
    const s = await t.game.getFarmState(p.farmId);
    expect(s.needsName).toBe(true);
    expect(s.name.toLowerCase()).not.toContain('zorbly');
    const all = JSON.stringify(await t.db.query(`SELECT * FROM trades`)) + JSON.stringify(await t.db.query(`SELECT * FROM players`)) + JSON.stringify(await t.db.query(`SELECT * FROM farms`));
    expect(all.toLowerCase()).not.toContain('zorbly');
    // the old name stays refused as a farm name (only its hash is kept)
    const [row] = await t.db.query(`SELECT name_guard_sha256, name_guard_len FROM players WHERE id = $1`, [p.playerId]);
    expect({ sha256: row?.name_guard_sha256, len: Number(row?.name_guard_len) }).toEqual(nameGuardOf('zorbly.k'));
    // and it runs once
    expect(await t.db.tx((q) => renameLegacyFarms(q))).toBe(0);
    await t.db.close();
  });
});
