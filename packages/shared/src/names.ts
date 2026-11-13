// Farm names. Every farm is named by its player (or keeps a generated one); a name is public (the
// board, trades, cards), so it is never taken from the player's sign-in. The rules are shared so
// the naming screen and the server agree: 3 to 24 characters of letters, numbers, spaces and simple
// punctuation, at least one letter, no rude words, unique in the season (case-insensitive), and
// never the player's email name (the server holds only its SHA-256 and length, see apps/server).
// Generated names come from goofy farm word lists: no real people or brands.

export const FARM_NAME_MIN = 3;
export const FARM_NAME_MAX = 24;
/** In-game days between two renames in Settings (the first choice is free). */
export const RENAME_EVERY_DAYS = 7;

const FIRST = [
  'Cluckingham',
  'Eggsworth',
  'Featherby',
  'Yolkshire',
  'Scrambleton',
  'Pecksworth',
  'Omeletteville',
  'Sunny Yolk',
  'Bok Bok',
  'Wattle',
  'Clucky',
  'Henley Hen',
  'Broody',
  'Fluffington',
  'Puddingfoot',
  'Speckled',
  'Grumbleby',
  'Waddlesby',
  'Henhouse',
  'Shellsworth',
  'Crumbleby',
  'Beakman',
  'Tumbleweed',
  'Doodle Doo',
  'Hatchling',
  'Nestor',
  'Pipsqueak',
  'Buttercup',
  'Crackling',
  'Haystack',
] as const;

const SECOND = ['Acres', 'Farm', 'Ranch', 'Roost', 'Hollow', 'Meadows', 'Patch', 'Coop', 'Yard', 'Fields', 'Homestead', 'Pastures', 'Paddock', 'Orchard', 'Barnyard', 'Nook'] as const;

/** A goofy farm name, such as "Cluckingham Acres". */
export function suggestFarmName(rnd: () => number = Math.random): string {
  for (;;) {
    const name = `${FIRST[Math.floor(rnd() * FIRST.length)]} ${SECOND[Math.floor(rnd() * SECOND.length)]}`;
    if (name.length <= FARM_NAME_MAX) return name;
  }
}

/** A name as stored and shown: trimmed, inner spaces collapsed. */
export const normalizeFarmName = (raw: string): string => raw.trim().replace(/\s+/g, ' ');

/** The key two names must not share in a season: the stored name, lower case. */
export const farmNameKey = (name: string): string => normalizeFarmName(name).toLowerCase();

/** Letters and digits only, lower case, rude-word disguises undone (0 to o, 1 to i, $ to s...). */
function plain(name: string): string {
  return name
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
}

/** Rude words: anywhere in a name. */
const RUDE_ANYWHERE = ['fuck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'nigg', 'fagg', 'retard', 'rapist', 'nazi', 'twat', 'porn', 'pussy', 'asshole', 'bastard', 'penis', 'vagina', 'dildo', 'jizz', 'kike', 'chink'];
/** Rude words that are also inside harmless ones (cockerel, Essex, title, swanky, spice): only as a whole word. */
const RUDE_WORDS = ['cock', 'cocks', 'dick', 'dicks', 'ass', 'sex', 'sexy', 'tit', 'tits', 'fag', 'cum', 'rape', 'boob', 'boobs', 'arse', 'piss', 'wank', 'wanker', 'spic'];

export function isRude(name: string): boolean {
  const all = plain(name);
  if (RUDE_ANYWHERE.some((w) => all.includes(w))) return true;
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9$@!|]+/)
    .map(plain)
    .filter(Boolean);
  return words.some((w) => RUDE_WORDS.includes(w));
}

/** Letters and digits of a name, lower case: what an email-name check compares. */
export const nameLetters = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export type FarmNameProblem = 'length' | 'characters' | 'letters' | 'rude' | 'email';

export const FARM_NAME_PROBLEM_TEXT: Record<FarmNameProblem | 'taken' | 'wait', string> = {
  length: `A FARM NAME IS ${FARM_NAME_MIN} TO ${FARM_NAME_MAX} CHARACTERS.`,
  characters: "LETTERS, NUMBERS, SPACES AND . , ' ! ? & - ONLY.",
  letters: 'A FARM NAME NEEDS AT LEAST ONE LETTER.',
  rude: 'THAT NAME IS NOT ALLOWED. TRY ANOTHER.',
  email: 'PICK A NAME THAT IS NOT YOUR EMAIL NAME: EVERY PLAYER SEES IT.',
  taken: 'ANOTHER FARM ON THE STREET HAS THAT NAME.',
  wait: 'YOU CAN RENAME YOUR FARM ONCE A WEEK (IN-GAME).',
};

/**
 * Checks a name against the shared rules. `emailName` (the client only: the local part of the
 * player's own email) is refused anywhere inside the name. Uniqueness and the server's own email
 * check (by hash) are checked by the server.
 */
export function checkFarmName(raw: string, emailName?: string | null): { ok: true; name: string } | { ok: false; problem: FarmNameProblem } {
  const name = normalizeFarmName(raw);
  if (name.length < FARM_NAME_MIN || name.length > FARM_NAME_MAX) return { ok: false, problem: 'length' };
  if (!/^[A-Za-z0-9 .,'!?&-]+$/.test(name)) return { ok: false, problem: 'characters' };
  if (!/[A-Za-z]/.test(name)) return { ok: false, problem: 'letters' };
  if (isRude(name)) return { ok: false, problem: 'rude' };
  const mine = emailName ? nameLetters(emailName) : '';
  if (mine.length >= 3 && nameLetters(name).includes(mine)) return { ok: false, problem: 'email' };
  return { ok: true, name };
}
