/**
 * Configuration hierarchy display utility
 *
 * Displays the configuration hierarchy with existence indicators,
 * default project location, and project folders.
 */

import chalk from 'chalk';
import { existsSync } from 'fs';
import { basename } from 'path';
import { getConfigLocations, ResolvedSettings } from './settings.js';

/** Padding width for folder names in display output */
const FOLDER_NAME_PADDING = 12;

export interface HierarchyDisplayOptions {
  showExistence?: boolean;
  showProjects?: boolean;
  /** Project directory for config path resolution (defaults to process.cwd()) */
  projectDir?: string;
}

/**
 * Display the configuration hierarchy with existence indicators
 * and configured project information.
 */
export function displayConfigHierarchy(
  settings: ResolvedSettings,
  options: HierarchyDisplayOptions = {}
): void {
  const { showExistence = true, showProjects = true, projectDir } = options;

  const locations = getConfigLocations(projectDir);

  // Display config file locations with existence
  console.log(chalk.bold('\n📁 Configuration Hierarchy:\n'));
  console.log(chalk.dim('  Priority (highest to lowest):'));

  displayConfigLevel(1, 'Project', locations.project, showExistence);
  displayConfigLevel(2, 'Global', locations.global, showExistence);
  displayConfigLevel(3, 'Default', locations.packageDefault, showExistence);

  if (showProjects) {
    displayDefaultProject(settings);
    displayProjectFolders(settings);
  }

  console.log();
}

/**
 * Display a single config level with existence indicator
 */
function displayConfigLevel(
  priority: number,
  name: string,
  path: string,
  showExistence: boolean
): void {
  const exists = existsSync(path);
  const indicator = showExistence
    ? exists
      ? chalk.green(' ✓')
      : chalk.dim(' ✗')
    : '';
  const pathColor = exists ? chalk.cyan : chalk.dim;

  console.log(`  ${priority}. ${name}:  ${pathColor(path)}${indicator}`);
}

/**
 * Display the default project location if configured
 */
function displayDefaultProject(settings: ResolvedSettings): void {
  const defaultProject = settings.default_project_location;

  if (!defaultProject) {
    return;
  }

  const exists = existsSync(defaultProject);
  const statusIndicator = exists
    ? chalk.green('✓ exists')
    : chalk.red('✗ path not found');

  console.log(chalk.bold('\n📍 Default Project:'));
  console.log(`  Location: ${chalk.cyan(defaultProject)}`);
  console.log(`  Status: ${statusIndicator}`);
}

/**
 * Display project folders if configured
 */
function displayProjectFolders(settings: ResolvedSettings): void {
  const folders = settings.folders;

  if (!folders || folders.length === 0) {
    return;
  }

  console.log(chalk.bold(`\n📂 Project Folders: ${folders.length} configured`));

  folders.forEach((folder, index) => {
    // Handle both string and object formats
    const folderPath = typeof folder === 'string' ? folder : folder.path;
    const folderName =
      (typeof folder === 'object' && folder.name) ||
      basename(folderPath) ||
      folderPath;

    const exists = existsSync(folderPath);
    const indicator = exists ? chalk.green('✓') : chalk.red('✗');
    const name = folderName.padEnd(FOLDER_NAME_PADDING);

    console.log(
      `  ${index + 1}. ${name} → ${chalk.cyan(folderPath)} ${indicator}`
    );
  });
}
