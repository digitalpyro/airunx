/**
 * Cursor CLI Adapter
 * Executes agent tasks via the cursor-agent CLI
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { BaseCliAdapter, type CliAdapterConfig } from './base-cli-adapter.js';
import type { ExecutionRequest } from '../core/adapter-types.js';
import { OPENAI_PRICING } from './pricing.js';
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_CLI_EXECUTABLES,
  DEFAULT_MODELS,
} from './constants.js';
import { ConfigurationError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

export class CursorAdapter extends BaseCliAdapter {
  name = 'cursor' as const;

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: DEFAULT_CLI_EXECUTABLES.CURSOR,
      installInstructions: 'curl https://cursor.com/install -fsS | bash',
      pricingMap: OPENAI_PRICING,
      defaultModel: DEFAULT_MODELS.OPENAI,
    };
  }

  protected buildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    const { agent } = request;

    // Get approval mode flags from settings
    const approvalFlags = this.getApprovalModeFlags();

    // Cursor CLI syntax per https://cursor.com/docs/cli/overview
    // - Use -p with the prompt as its value for non-interactive execution
    // - --model and --output-format are top-level flags
    // Note: -p takes the prompt as its argument value, not as a separate positional
    return [
      '--model',
      agent.preferredModel || DEFAULT_MODELS.OPENAI,
      '--output-format',
      'text',
      ...approvalFlags,
      '-p',
      prompt,
    ];
  }

  protected buildEnv(): Record<string, string | undefined> {
    return {
      [DEFAULT_API_KEY_ENV.cursor]:
        this.config?.apiKey || process.env[DEFAULT_API_KEY_ENV.cursor] || '',
    };
  }

  /**
   * Validate Cursor CLI authentication status
   * cursor-agent requires interactive login before automation works
   *
   * @throws ConfigurationError if not authenticated
   * @throws BackendNotFoundError if cursor-agent has issues
   */
  protected async validateBackend(): Promise<void> {
    const cliConfig = this.getCliConfig();

    try {
      // Try to get cursor-agent status to check authentication
      const { stdout, stderr } = await execFileAsync(cliConfig.cliCommand, [
        'status',
      ]);

      const output = `${stdout} ${stderr}`.toLowerCase();

      // Check for signs that authentication is required
      if (
        output.includes('not logged in') ||
        output.includes('sign in') ||
        output.includes('press any key') ||
        output.includes('login required')
      ) {
        throw new ConfigurationError(
          `Cursor CLI requires authentication.\n` +
            `Run: ${cliConfig.cliCommand} login\n` +
            `This will open a browser for OAuth authentication.`,
          'cursor.authentication'
        );
      }
    } catch (error) {
      // If it's already a ConfigurationError, re-throw it
      if (error instanceof ConfigurationError) {
        throw error;
      }

      // Any failure from the status command should be treated as a validation failure.
      // This ensures we fail fast rather than masking potential issues.
      throw new ConfigurationError(
        `Failed to verify Cursor CLI status: ${error instanceof Error ? error.message : error}\n` +
          `Please ensure '${cliConfig.cliCommand}' is installed correctly and try running '${cliConfig.cliCommand} login'.`,
        'cursor.authentication'
      );
    }
  }
}
