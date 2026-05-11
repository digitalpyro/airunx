/**
 * Doctor command - diagnose backend availability and configuration
 */

import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'path';
import { BackendValidator } from '../../adapters/backend-validator.js';
import { loadSystemConfig } from '../../utils/system-config.js';
import {
  validateEnv,
  loadPipelineConfigWithSource,
} from '../../utils/config.js';
import { GitHubCLI } from '../../integrations/github-cli.js';
import { GitWorktreeManager } from '../../tools/git-worktree.js';
import {
  toDisplayName,
  DEFAULT_API_KEY_ENV,
} from '../../adapters/constants.js';
import {
  getAllFidelityCostEstimates,
  resolveFidelity,
  getFidelityConfig,
} from '../../utils/fidelity-resolver.js';
import { PIPELINE_TYPES, FidelityParametersSchema } from '../../core/types.js';
import {
  validateAgentsConfig,
  validatePipelinesConfig,
  reportValidationResult,
} from '../../utils/config-validator.js';
import { loadSettings } from '../../utils/settings.js';
import {
  CircuitBreaker,
  CircuitState,
  DEFAULT_STATE,
  getDefaultStateFilePath,
} from '../../utils/circuit-breaker.js';

export async function doctorCommand(): Promise<void> {
  console.log(chalk.bold.blue('🔍 Running AIRunX diagnostics...\n'));

  const spinner = ora('Checking backends...').start();

  try {
    // 1. Check Node.js version
    spinner.text = 'Checking Node.js version...';
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);

    spinner.stop();
    console.log(chalk.bold('📦 Node.js:'));
    if (nodeMajor >= 18) {
      console.log(chalk.green(`  ✓ ${nodeVersion} (supported)\n`));
    } else {
      console.log(chalk.red(`  ✗ ${nodeVersion} (requires >= 18.0.0)\n`));
    }

    // 2. Check environment variables
    spinner.start('Checking environment variables...');
    try {
      const env = validateEnv();
      spinner.stop();
      console.log(chalk.bold('🔑 Environment Variables:'));

      // Use centralized constant to ensure consistency and avoid duplication
      const envKeys = Object.values(DEFAULT_API_KEY_ENV);
      const maxLength = Math.max(...envKeys.map((k) => k.length));

      for (const key of envKeys) {
        const value = env[key as keyof typeof env];
        const status = value ? chalk.green('✓ Set') : chalk.yellow('○ Not set');
        console.log(`  ${key.padEnd(maxLength)}: ${status}`);
      }
      console.log();
    } catch {
      spinner.stop();
      console.log(
        chalk.yellow('  ⚠ Some environment variables may be missing\n')
      );
    }

    // 3. Check backends (with deep validation including authentication)
    spinner.start('Checking backend availability and authentication...');
    const validator = new BackendValidator();
    // Use deep=true to also verify authentication status
    const available = await validator.validateBackends(undefined, true);

    spinner.stop();
    console.log(chalk.bold('🤖 Backend Availability & Authentication:\n'));

    // Iterate over all available backends to automatically include new backends
    for (const [backend, status] of Object.entries(available)) {
      const displayName = toDisplayName(backend);
      if (status?.available) {
        console.log(
          chalk.green(
            `  ✓ ${displayName}: ${status.version || 'Available'} (authenticated)`
          )
        );
      } else {
        // Distinguish between "not installed" and "installed but auth required"
        const hasVersion = status?.version;
        if (hasVersion) {
          // CLI exists but auth/init failed
          console.log(
            chalk.yellow(`  ⚠ ${displayName}: ${hasVersion} (requires setup)`)
          );
          console.log(
            chalk.dim(`    ${status?.error || 'Authentication required'}`)
          );
        } else {
          // CLI not found
          console.log(
            chalk.red(`  ✗ ${displayName}: ${status?.error || 'Not found'}`)
          );
          if (status?.installInstructions) {
            console.log(
              chalk.dim(`    Install: ${status.installInstructions}`)
            );
          }
        }
      }
    }

    console.log();

    // 4. Check GitHub CLI
    spinner.start('Checking GitHub CLI...');
    const ghStatus = await GitHubCLI.isAvailable();

    spinner.stop();
    console.log(chalk.bold('🔧 GitHub CLI:'));
    if (ghStatus.available) {
      const via =
        ghStatus.authMethod === 'token' ? '(via GITHUB_TOKEN)' : '(via gh CLI)';
      console.log(chalk.green(`  ✓ gh CLI authenticated ${via}`));
    } else {
      console.log(chalk.red(`  ✗ gh CLI: ${ghStatus.error}`));
      console.log(
        chalk.dim(
          '    Hint: For CI/CD, set GITHUB_TOKEN. For local dev, run: gh auth login'
        )
      );
    }
    console.log();

    // 5. Check Git repository
    spinner.start('Checking Git repository...');
    const worktreeManager = new GitWorktreeManager();
    const isGitRepo = await worktreeManager.isGitRepo();

    spinner.stop();
    console.log(chalk.bold('📁 Git Repository:'));
    if (isGitRepo) {
      console.log(chalk.green('  ✓ Git repository detected'));
      try {
        const mainBranch = await worktreeManager.getMainBranch();
        console.log(chalk.dim(`    Main branch: ${mainBranch}`));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.log(
          chalk.yellow(
            `    ⚠ Could not determine main branch: ${errorMessage}`
          )
        );
      }
    } else {
      console.log(chalk.yellow('  ○ Not a git repository'));
      console.log(chalk.dim('    Worktree features will not be available'));
    }
    console.log();

    // 6. Check pipeline configuration (uses centralized loading utility)
    spinner.start('Checking pipeline configuration...');
    const pipelineResult = loadPipelineConfigWithSource();

    spinner.stop();
    console.log(chalk.bold('🔄 Pipeline Configuration:'));
    if (pipelineResult) {
      console.log(chalk.green(`  ✓ ${pipelineResult.sourcePath}`));
      console.log(
        chalk.dim(`    ${pipelineResult.pipelineCount} pipeline(s) defined`)
      );
      console.log(
        chalk.dim(`    Available types: ${PIPELINE_TYPES.join(', ')}`)
      );
    } else {
      console.log(chalk.yellow('  ○ No valid pipelines.yaml found'));
      console.log(chalk.dim('    Run: airunx init'));
    }
    console.log();

    // 6.5. Validate workflow configuration files
    spinner.start('Validating workflow configuration...');
    const settings = loadSettings();
    const agentsPath = settings.resolvedPaths?.agents_md;
    const pipelinesPath = settings.resolvedPaths?.pipelines_yaml;

    spinner.stop();
    console.log(chalk.bold('📝 Workflow Configuration Validation:'));

    if (agentsPath) {
      const agentsValidation = validateAgentsConfig(agentsPath);
      reportValidationResult('AGENTS.md', agentsValidation, chalk);
    } else {
      console.log(chalk.yellow('  ○ AGENTS.md path not configured'));
    }

    if (pipelinesPath) {
      const pipelinesValidation = validatePipelinesConfig(pipelinesPath);
      reportValidationResult('pipelines.yaml', pipelinesValidation, chalk);
    } else {
      console.log(chalk.yellow('  ○ pipelines.yaml path not configured'));
    }
    console.log();

    // 7. Check system configuration
    spinner.start('Checking system configuration...');
    let config = null;
    let configError = null;

    try {
      config = loadSystemConfig();
    } catch (error) {
      configError = error as Error;
    }

    spinner.stop();
    if (configError) {
      console.log(chalk.bold('⚙️  System Configuration:'));
      console.log(chalk.red('  ✗ .airunx/config.yml found but invalid'));
      console.log(chalk.red(`  Error: ${configError.message}`));
      console.log(chalk.dim('  Fix the configuration or run: airunx init\n'));
    } else if (config) {
      console.log(chalk.bold('⚙️  System Configuration:'));
      console.log(chalk.green('  ✓ .airunx/config.yml found'));
      console.log(chalk.dim(`  Default backend: ${config.fallback_backend}`));
      console.log(
        chalk.dim(
          `  Configured backends: ${Object.keys(config.backends).join(', ')}`
        )
      );
      console.log();
    } else {
      console.log(chalk.yellow('⚙️  System Configuration:'));
      console.log(chalk.yellow('  ○ No .airunx/config.yml found'));
      console.log(chalk.dim('  Run: airunx init\n'));
    }

    // 8. Check fidelity configuration and cost estimates
    if (config) {
      console.log(chalk.bold('💰 Execution Fidelity Cost Estimates:\n'));

      // Display fidelity config (already validated by loadSystemConfig via Zod)
      if (config.execution_fidelity) {
        console.log(
          chalk.green(
            `  ✓ Default fidelity: ${config.execution_fidelity.default_level}`
          )
        );
      }

      // Show cost estimates
      const costEstimates = getAllFidelityCostEstimates(); // Uses DEFAULT_BASELINE_COST from fidelity-resolver

      console.log(
        chalk.dim(
          '  Estimates based on empirical production data (issue #251):'
        )
      );
      console.log();
      console.log(
        `    fast:     ~$${costEstimates.fast.toFixed(0)}-${Math.ceil(costEstimates.fast * 1.5)} per workflow`
      );
      console.log(
        `    standard: ~$${costEstimates.standard.toFixed(0)}-${Math.ceil(costEstimates.standard * 1.5)} per workflow  ${chalk.dim('(default)')}`
      );
      console.log(
        `    thorough: ~$${costEstimates.thorough.toFixed(0)}-${Math.ceil(costEstimates.thorough * 1.5)} per workflow`
      );
      console.log(
        `    ultra:    ~$${costEstimates.ultra.toFixed(0)}-${Math.ceil(costEstimates.ultra * 1.5)} per workflow`
      );
      console.log();

      console.log(
        chalk.dim(
          '  Use --fidelity flag to override: airunx run --fidelity fast\n'
        )
      );

      // 8.5 Fidelity resolution testing
      console.log(chalk.bold('🔬 Fidelity Resolution Test:\n'));

      // Test CLI flag override
      const cliResolution = resolveFidelity({
        cliFlag: 'thorough',
        systemConfig: config,
      });
      console.log(
        chalk.green(
          `  ✓ CLI flag: --fidelity thorough → ${cliResolution.level}`
        )
      );

      // Test system config default
      const systemResolution = resolveFidelity({
        systemConfig: config,
      });
      console.log(
        chalk.green(
          `  ✓ System default: ${systemResolution.level} (from ${systemResolution.source})`
        )
      );

      // Test fallback to hardcoded default
      const fallbackResolution = resolveFidelity({});
      console.log(
        chalk.green(
          `  ✓ Fallback default: ${fallbackResolution.level} (hardcoded)`
        )
      );

      // Data-driven validation using Zod schema (single source of truth)
      console.log();
      console.log(chalk.dim('  Parameter validation:'));
      let allParamsValid = true;

      const fidelityConfig = getFidelityConfig(config);
      for (const [level, params] of Object.entries(fidelityConfig.levels)) {
        const result = FidelityParametersSchema.safeParse(params);

        if (result.success) {
          console.log(
            chalk.green(
              `    ✓ ${level}: temp=${params.temperature}, maxTokens=${params.maxTokens}, retryCount=${params.retryCount}`
            )
          );
        } else {
          const errorMessages = result.error.errors.map(
            (e) => `${e.path.join('.')}: ${e.message}`
          );
          console.log(
            chalk.red(
              `    ✗ ${level}: invalid parameters: ${errorMessages.join(', ')}`
            )
          );
          allParamsValid = false;
        }
      }

      if (allParamsValid) {
        console.log(chalk.green('\n  ✓ All fidelity parameters valid\n'));
      } else {
        console.log(chalk.red('\n  ✗ Some fidelity parameters invalid\n'));
      }
    }

    // 9. Check Circuit Breaker Status
    spinner.start('Checking circuit breaker status...');
    const stateFilePath = resolve(process.cwd(), getDefaultStateFilePath());
    const circuitBreaker = new CircuitBreaker(stateFilePath);
    const circuitStates = await circuitBreaker.getAllStates();

    spinner.stop();
    console.log(chalk.bold('🔌 Circuit Breaker Status:\n'));

    let hasOpenCircuits = false;
    for (const backend of Object.keys(available)) {
      const state = circuitStates[backend] || { ...DEFAULT_STATE };

      const displayName = toDisplayName(backend);

      switch (state.state) {
        case CircuitState.CLOSED:
          console.log(chalk.green(`  ✓ ${displayName}: CLOSED (healthy)`));
          break;
        case CircuitState.OPEN:
          hasOpenCircuits = true;
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
          break;
        case CircuitState.HALF_OPEN:
          console.log(chalk.yellow(`  ○ ${displayName}: HALF_OPEN (testing)`));
          break;
      }
    }

    if (hasOpenCircuits) {
      console.log();
      console.log(
        chalk.dim('  To reset a circuit: airunx circuit reset <backend>')
      );
    }
    console.log();

    // 10. Overall health check
    const availableBackends = Object.values(available).filter(
      (b) => b.available
    );
    const hasConfig = config !== null;
    const hasGh = ghStatus.available;
    const hasGit = isGitRepo;

    console.log(chalk.bold('📋 Summary:\n'));

    if (availableBackends.length > 0 && hasConfig) {
      const readiness = hasGh && hasGit ? 'fully ready' : 'ready';
      console.log(
        chalk.green(
          `  ✓ System is ${readiness}! ${availableBackends.length} backend(s) available.`
        )
      );
      console.log(chalk.dim('  Run: airunx run <input>\n'));
    } else if (availableBackends.length > 0 && !hasConfig) {
      console.log(
        chalk.yellow(
          '  ⚠ Backends available but not configured. Run: airunx init\n'
        )
      );
    } else if (availableBackends.length === 0) {
      console.log(
        chalk.red('  ✗ No backends available. Install at least one backend:\n')
      );
      console.log(chalk.cyan('  Quickest option:'));
      console.log(chalk.cyan('    npm install -g @anthropic-ai/claude-code'));
      console.log(chalk.cyan('    export ANTHROPIC_API_KEY="your-key"\n'));
    }
  } catch (error) {
    spinner.stop();
    console.error(chalk.red('✗ Diagnostics failed'));
    console.error(error);
    process.exit(1);
  }
}
