import chalk from 'chalk';
import { redactSecrets } from './redaction.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(7);
    return `${chalk.dim(timestamp)} ${this.getLevelColor(level)(levelStr)} [${chalk.cyan(this.context)}] ${message}`;
  }

  private getLevelColor(level: LogLevel): typeof chalk.blue {
    switch (level) {
      case 'info':
        return chalk.blue;
      case 'warn':
        return chalk.yellow;
      case 'error':
        return chalk.red;
      case 'debug':
        return chalk.gray;
      case 'success':
        return chalk.green;
      default:
        return chalk.white;
    }
  }

  private isQuiet(): boolean {
    return process.env.AIRUNX_QUIET === '1';
  }

  info(message: string): void {
    if (this.isQuiet()) return;
    console.log(this.formatMessage('info', message));
  }

  warn(message: string, error?: unknown): void {
    if (this.isQuiet()) return;
    console.log(this.formatMessage('warn', message));
    if (error) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      // Always show error message, stack trace only in DEBUG mode
      console.error(chalk.yellow(`  Error: ${errorObj.message}`));
      if (process.env.DEBUG) {
        console.error(chalk.dim(errorObj.stack));
      }
    }
  }

  error(message: string, error?: unknown): void {
    console.error(this.formatMessage('error', message));
    if (error) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      // Always show error message, stack trace only in DEBUG mode
      console.error(chalk.red(`  Error: ${errorObj.message}`));
      if (process.env.DEBUG) {
        console.error(chalk.dim(errorObj.stack));
      }
    }
  }

  debug(message: string, data?: unknown): void {
    if (process.env.DEBUG) {
      console.log(this.formatMessage('debug', redactSecrets(message)));
      if (data) {
        console.log(chalk.dim(redactSecrets(JSON.stringify(data, null, 2))));
      }
    }
  }

  success(message: string): void {
    if (this.isQuiet()) return;
    console.log(this.formatMessage('success', message));
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}
