/**
 * Circuit Breaker CLI Commands
 * Manage circuit breaker state for backends
 */

import chalk from 'chalk';
import { resolve } from 'path';
import {
  CircuitBreaker,
  CircuitState,
  DEFAULT_STATE,
  getDefaultStateFilePath,
} from '../../utils/circuit-breaker.js';
import { BACKEND_TYPES, type BackendType } from '../../core/adapter-types.js';
import { toDisplayName } from '../../adapters/constants.js';

/**
 * Show circuit breaker status for all backends
 */
export async function circuitStatusCommand(): Promise<void> {
  console.log(chalk.bold.blue('🔌 Circuit Breaker Status\n'));

  const stateFilePath = resolve(process.cwd(), getDefaultStateFilePath());
  const circuitBreaker = new CircuitBreaker(stateFilePath);

  const states = await circuitBreaker.getAllStates();

  // Show status for all known backends
  for (const backend of BACKEND_TYPES) {
    const state = states[backend] || { ...DEFAULT_STATE };

    const displayName = toDisplayName(backend);

    switch (state.state) {
      case CircuitState.CLOSED:
        console.log(chalk.green(`  ✓ ${displayName}: CLOSED (healthy)`));
        if (state.successCount > 0) {
          console.log(chalk.dim(`    Successes: ${state.successCount}`));
        }
        break;

      case CircuitState.OPEN:
        console.log(chalk.red(`  ✗ ${displayName}: OPEN (failing)`));
        console.log(chalk.dim(`    Failures: ${state.failureCount}`));
        if (state.openedAt) {
          const retryTime = circuitBreaker.getRetryTime(state);
          if (retryTime) {
            const now = new Date();
            const msUntilRetry = retryTime.getTime() - now.getTime();
            if (msUntilRetry > 0) {
              const secsUntilRetry = Math.ceil(msUntilRetry / 1000);
              console.log(
                chalk.dim(`    Will retry in: ${secsUntilRetry} seconds`)
              );
            } else {
              console.log(
                chalk.dim('    Ready to retry (HALF_OPEN transition)')
              );
            }
          }
        }
        if (state.resetAttempts > 0) {
          console.log(chalk.dim(`    Reset attempts: ${state.resetAttempts}`));
        }
        break;

      case CircuitState.HALF_OPEN:
        console.log(chalk.yellow(`  ○ ${displayName}: HALF_OPEN (testing)`));
        console.log(chalk.dim('    Allowing test request...'));
        break;
    }
  }

  console.log();
  console.log(chalk.dim('Commands:'));
  console.log(chalk.dim('  airunx circuit reset <backend>  Reset a circuit'));
  console.log(chalk.dim('  airunx doctor                   Full diagnostics'));
  console.log();
}

/**
 * Reset circuit breaker for a specific backend
 */
export async function circuitResetCommand(backend: string): Promise<void> {
  // Validate backend
  if (!BACKEND_TYPES.includes(backend as BackendType)) {
    console.error(chalk.red(`Error: Invalid backend '${backend}'`));
    console.error(chalk.dim(`Valid backends: ${BACKEND_TYPES.join(', ')}`));
    process.exit(1);
  }

  const stateFilePath = resolve(process.cwd(), getDefaultStateFilePath());
  const circuitBreaker = new CircuitBreaker(stateFilePath);

  // Get current state before reset
  const stateBefore = await circuitBreaker.getState(backend);
  const displayName = toDisplayName(backend);

  if (
    stateBefore.state === CircuitState.CLOSED &&
    stateBefore.failureCount === 0
  ) {
    console.log(
      chalk.yellow(
        `Circuit for ${displayName} is already healthy (CLOSED with no failures)`
      )
    );
    return;
  }

  // Reset the circuit
  await circuitBreaker.reset(backend);

  console.log(chalk.green(`✓ Circuit for ${displayName} has been reset`));
  console.log(chalk.dim(`  Previous state: ${stateBefore.state}`));
  console.log(chalk.dim(`  Previous failures: ${stateBefore.failureCount}`));
  console.log(chalk.dim('  New state: CLOSED'));
  console.log();
  console.log(chalk.dim('The backend will be retried on the next execution.'));
}
