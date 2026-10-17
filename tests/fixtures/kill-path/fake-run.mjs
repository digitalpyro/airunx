// Fake `airunx run` for heartbeat group-kill tests (U9).
// Usage: node fake-run.mjs <fake-cli-path> <signal-log-path> <grandchild-pid-path>
// Spawns a signal-ignoring fake CLI (NOT detached, so it joins this process
// group), records its pid, and itself ignores SIGTERM — only the heartbeat's
// group SIGKILL can stop either of them.
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';

const [cliPath, logPath, pidPath] = process.argv.slice(2);
const child = spawn(process.execPath, [cliPath, 'ignore', logPath], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
writeFileSync(pidPath, String(child.pid));
process.on('SIGTERM', () => appendFileSync(logPath, 'run SIGTERM\n'));
setInterval(() => {}, 1_000);
