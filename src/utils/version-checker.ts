/**
 * Version checker for AIRunX
 *
 * Checks if the current installation is up-to-date with the npm registry.
 * This ensures users are running the latest version of the software.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger.js';
import { getPackageRoot } from './paths.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

const execFileAsync = promisify(execFile);
const logger = createLogger('version-checker');

/** Package name on npm registry */
const PACKAGE_NAME = 'airunx';

export interface VersionCheckResult {
  /** Whether the check was successful */
  success: boolean;
  /** Whether the installation is up-to-date */
  isUpToDate: boolean;
  /** Current installed version */
  currentVersion?: string;
  /** Latest version on npm registry */
  latestVersion?: string;
  /** Error message if check failed */
  error?: string;
}

/**
 * Parse semver version string into comparable parts
 */
function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Compare two semver versions
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  if (!parsedA || !parsedB) return 0;

  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1;
  }
  return 0;
}

/**
 * Get the currently installed version from package.json
 */
async function getCurrentVersion(): Promise<string> {
  const packageRoot = getPackageRoot();
  const packageJsonPath = join(packageRoot, 'package.json');

  const content = await readFile(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(content);

  return packageJson.version || '0.0.0';
}

/**
 * Get the latest version from npm registry
 */
async function getLatestNpmVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', PACKAGE_NAME, 'version'],
      {
        timeout: 10000, // 10 second timeout
      }
    );
    return stdout.trim();
  } catch (error) {
    // Package might not be published yet, or network error
    logger.debug(
      `Could not fetch npm version: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    return null;
  }
}

/**
 * Check if the AIRunX installation is up-to-date with the npm registry
 *
 * @returns Version check result with update status
 */
export async function checkVersion(): Promise<VersionCheckResult> {
  try {
    const currentVersion = await getCurrentVersion();

    // Try to get latest version from npm
    const latestVersion = await getLatestNpmVersion();

    if (!latestVersion) {
      // Can't check npm - package may not be published yet
      logger.debug(
        'Could not get latest version from npm (package may not be published yet)'
      );
      return {
        success: true,
        isUpToDate: true, // Assume up-to-date if we can't check
        currentVersion,
      };
    }

    const comparison = compareVersions(currentVersion, latestVersion);
    const isUpToDate = comparison >= 0;

    return {
      success: true,
      isUpToDate,
      currentVersion,
      latestVersion,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'unknown error';
    logger.debug(`Version check failed: ${errorMsg}`);
    return {
      success: false,
      isUpToDate: true, // On error, don't block the user
      error: errorMsg,
    };
  }
}

/**
 * Format version check result as a user-friendly message
 *
 * @param result - Version check result
 * @returns Formatted message string or null if up-to-date
 */
export function formatVersionMessage(
  result: VersionCheckResult
): string | null {
  if (!result.success || result.isUpToDate) {
    return null;
  }

  const parts: string[] = [];

  if (result.currentVersion && result.latestVersion) {
    parts.push(
      `A new version of AIRunX is available: ${result.latestVersion} (current: ${result.currentVersion})`
    );
  }

  parts.push('Run "npm update -g airunx" to update.');
  parts.push('Use --skip-version-check to disable this warning.');

  return parts.join('\n');
}
