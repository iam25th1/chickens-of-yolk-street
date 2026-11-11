// Runs the game server and the client dev server side by side; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = ['@coys/server', '@coys/client'].map((ws) =>
  spawn(npm, ['run', 'dev', '-w', ws], { stdio: 'inherit', shell: process.platform === 'win32' }),
);

const stop = () => {
  for (const child of children) if (!child.killed) child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code) { stop(); process.exitCode = code; } });
