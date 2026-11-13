// Log lines never carry a player's email: anything shaped like an email address is replaced
// before a line is written. (The game never receives emails; this is the last safeguard.)
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export const redactEmails = (line: string): string => line.replace(EMAIL, '[email]');
