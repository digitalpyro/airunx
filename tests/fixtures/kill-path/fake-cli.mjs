// Fake agent CLI for kill-path tests (U9).
// Usage: node fake-cli.mjs <mode> <signal-log-path>
//   honor   — on SIGINT print Claude-style result JSON and exit
//   ignore  — ignore SIGINT and SIGTERM (only SIGKILL stops it)
//   late    — on SIGINT print plain text, then exit 0
//   finish  — print result JSON after 50ms and exit 0 (no signal needed)
//   grandchild — start a detached `sleep 30` sharing this process's
//             stdout/stderr (holds the pipes open), log `grandchild <pid>`,
//             then exit 130 on SIGINT; the caller must kill the grandchild
// Every received signal is appended to the log, one per line; the first
// line is `pid <pid>`, written once the signal handlers are installed.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, logPath] = process.argv.slice(2);
const log = (line) => appendFileSync(logPath, `${line}\n`);

const resultJson = JSON.stringify({
  type: 'result',
  result: 'stopped early',
  session_id: 'fake-session',
  total_cost_usd: 0.123,
  usage: { input_tokens: 1000, output_tokens: 200 },
});

process.stderr.write('working\n');
const keepAlive = setInterval(() => {}, 1_000);

if (mode === 'finish') {
  setTimeout(() => {
    process.stdout.write(resultJson);
    process.exit(0);
  }, 50);
}

if (mode === 'grandchild') {
  const sleeper = spawn('sleep', ['30'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  sleeper.unref();
  log(`grandchild ${sleeper.pid}`);
}

process.on('SIGINT', () => {
  log('SIGINT');
  if (mode === 'honor') {
    process.stdout.write(resultJson, () => process.exit(130));
  } else if (mode === 'late') {
    process.stdout.write('partial work after signal\n', () => process.exit(0));
  } else if (mode === 'grandchild') {
    process.exit(130);
  }
});

process.on('SIGTERM', () => {
  log('SIGTERM');
  if (mode !== 'ignore') {
    clearInterval(keepAlive);
    process.exit(143);
  }
});

log(`pid ${process.pid}`);
