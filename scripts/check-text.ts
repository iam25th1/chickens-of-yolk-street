// House rule check: no em dash in any tracked text file. Run by `npm run lint`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EM_DASH = String.fromCharCode(0x2014);
const BINARY = /\.(png|mp3|ogg|ttf|woff2?|wasm|ico)$/i;

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !BINARY.test(f));

const hits: string[] = [];
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (line.includes(EM_DASH)) hits.push(`${file}:${i + 1}`);
  });
}

if (hits.length) {
  console.error(`em dash found in ${hits.length} place(s):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`text check: ${files.length} files, no em dashes`);
