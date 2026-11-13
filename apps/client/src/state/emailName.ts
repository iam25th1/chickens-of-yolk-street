// The player's email name, held in memory for this visit only (never stored, never sent), so the
// naming screen can say at once that a farm name contains it. The server refuses such names by hash.
let emailName = '';

export const rememberEmailName = (name: string): void => {
  emailName = name;
};

export const myEmailName = (): string => emailName;
