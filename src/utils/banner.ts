/**
 * Banner utility for AIRunX CLI
 *
 * Generates a branded ASCII block art banner using the ANSI Shadow font
 * with a dark blue to silver gradient effect.
 */

import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import boxen, { type Options as BoxenOptions } from 'boxen';

/** Options for banner generation */
export interface BannerOptions {
  /** Version string to display */
  version: string;
  /** Whether to wrap banner in a box (default: true) */
  showBox?: boolean;
}

/** Dark blue color for gradient start */
const DARK_BLUE = '#1E3A8A';

/** Silver color for gradient end */
const SILVER = '#C0C0C0';

/** AIRunX gradient using dark blue to silver */
const airunxGradient = gradient([DARK_BLUE, SILVER]);

/**
 * Generate the AIRunX banner with ASCII block art
 *
 * @param options - Banner configuration options
 * @returns Formatted banner string with colors and optional box
 */
export async function createBanner(options: BannerOptions): Promise<string> {
  const { version, showBox = true } = options;

  // Generate ASCII block art using ANSI Shadow font
  const asciiText = await new Promise<string>((resolve, reject) => {
    figlet.text(
      'AIRunX',
      {
        font: 'ANSI Shadow',
        horizontalLayout: 'default',
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result || '');
      }
    );
  });

  // Apply dark blue to silver gradient to the multiline ASCII art
  const gradientBanner = airunxGradient.multiline(asciiText);

  // Build the content lines (centered in box)
  const lines: string[] = [
    gradientBanner,
    '',
    chalk.bold.blue('🚀 Initializing AIRunX...'),
    chalk.dim(
      '🤖 AI agent orchestrator for automated development and execution'
    ),
    chalk.yellow(`⚠️  You are installing: AIRunX Version ${version}`),
  ];

  const content = lines.join('\n');

  if (showBox) {
    const boxOptions: BoxenOptions = {
      padding: 1,
      margin: { top: 0, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: DARK_BLUE,
      textAlignment: 'center',
    };

    return boxen(content, boxOptions);
  }

  return content;
}

/**
 * Display the AIRunX banner to stdout
 *
 * Only displays the banner if stdout is a TTY (interactive terminal).
 * Respects NO_COLOR environment variable for accessibility.
 *
 * @param version - Version string to display
 */
export async function displayBanner(version: string): Promise<void> {
  // Skip banner if not in a TTY environment (piped output)
  if (!process.stdout.isTTY) {
    return;
  }

  // Skip banner if NO_COLOR is set (accessibility)
  if (process.env.NO_COLOR !== undefined) {
    console.log(`\nAIRunX v${version}\n`);
    console.log(
      'AI agent orchestrator for automated development and execution'
    );
    return;
  }

  const banner = await createBanner({ version, showBox: true });
  console.log(banner);
}
