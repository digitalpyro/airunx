// Fake `airunx run` for heartbeat group-kill tests (U9).
// Usage: node fake-run.mjs <fake-cli-path> <signal-log-path> <grandchild-pid-path> [exit]
// Spawns a signal-ignoring fake CLI (NOT detached, so it joins this process
// group), records its pid, and itself ignores SIGTERM — only the heartbeat's
// group SIGKILL can stop either of them. With `exit`, run exits on its own
// after 200ms, leaving the CLI behind in its process group.
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';

const [cliPath, logPath, pidPath, mode] = process.argv.slice(2);
const child = spawn(process.execPath, [cliPath, 'ignore', logPath], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
writeFileSync(pidPath, String(child.pid));
process.on('SIGTERM', () => appendFileSync(logPath, 'run SIGTERM\n'));
setInterval(() => {}, 1_000);
if (mode === 'exit') setTimeout(() => process.exit(0), 200);
