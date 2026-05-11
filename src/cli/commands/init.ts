import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  statSync,
  readdirSync,
} from 'fs';
import { join, relative, isAbsolute, resolve } from 'path';
import { BackendValidator } from '../../adapters/backend-validator.js';
import {
  generateDefaultConfig,
  saveSystemConfig,
} from '../../utils/system-config.js';
import type { BackendType } from '../../core/adapter-types.js';
import type { ExecutionFidelityLevel } from '../../core/types.js';
import { EXECUTION_FIDELITY_LEVELS } from '../../core/types.js';
import { createLogger } from '../../utils/logger.js';
import { handleCommandError } from '../../utils/error-handlers.js';
import { expandPath } from '../../utils/settings.js';
import { toDisplayName } from '../../adapters/constants.js';
import {
  clearSettingsCache,
  loadSettings,
  type Settings,
} from '../../utils/settings.js';
import { displayConfigHierarchy } from '../../utils/display-hierarchy.js';
import {
  getPackageDefaultDir,
  resolveAgentsMdPath,
} from '../../utils/paths.js';
import {
  validateAgentsMdWithConfirmation,
  formatAgentsValidationResult,
} from '../../utils/agents-validator.js';
import {
  getAllFidelityCostEstimates,
  FIDELITY_DESCRIPTIONS,
  FIDELITY_USE_CASES,
} from '../../utils/fidelity-resolver.js';
import { displayBanner } from '../../utils/banner.js';
import { getPackageVersion } from '../../utils/paths.js';
import { parseWorkspaceFolders } from '../../utils/workspace-loader.js';
import { parseJsonc } from '../../utils/json-utils.js';

interface InitOptions {
  force?: boolean;
  reset?: boolean;
  fromWorkspace?: string;
  /** Directory for cloning repos in server deployments */
  workspace?: string;
  /** Path to .env file (loads before backend detection) */
  dotenv?: string;
}

/** Padding width for fidelity level names in selection list */
const FIDELITY_LEVEL_PADDING = 10;

/**
 * Copy a file if source exists and destination doesn't exist (or force is true)
 */
function copyOptionalFile(
  sourcePath: string,
  destinationPath: string,
  force: boolean,
  logMessage: string
): void {
  if (existsSync(sourcePath) && (!existsSync(destinationPath) || force)) {
    copyFileSync(sourcePath, destinationPath);
    console.log(chalk.green(logMessage));
  }
}

/**
 * Exit with error message for invalid paths (fail fast)
 */
function exitOnInvalidPaths(invalidPaths: string[], context: string): void {
  if (invalidPaths.length === 0) return;

  if (invalidPaths.length === 1) {
    console.error(
      chalk.red(`\n❌ ${context} does not exist: ${invalidPaths[0]}`)
    );
  } else {
    console.error(
      chalk.red(
        `\n❌ Invalid ${context.toLowerCase()}:\n${invalidPaths.map((p) => `   - ${p}`).join('\n')}`
      )
    );
  }
  console.error(
    chalk.yellow('\nPlease ensure all paths exist before running init.\n')
  );
  process.exit(1);
}

/**
 * Validate paths exist and resolve to absolute paths in a single pass
 * More efficient than separate validation and resolution loops
 *
 * @param paths - Array of paths to validate and resolve
 * @param contextForError - Context string for error messages
 * @param baseDir - Base directory for resolving relative paths
 */
function validateAndResolvePaths(
  paths: string[],
  contextForError: string,
  baseDir: string
): string[] {
  const results = paths.map((p) => {
    const resolved = isAbsolute(p) ? p : resolve(baseDir, p);
    const exists = existsSync(resolved);
    const isDirectory = exists && statSync(resolved).isDirectory();
    return { original: p, resolved, exists, isDirectory };
  });

  // Check for non-existent paths
  const nonExistent = results.filter((r) => !r.exists);
  if (nonExistent.length > 0) {
    exitOnInvalidPaths(
      nonExistent.map((i) => i.original),
      contextForError
    );
  }

  // Check for non-directory paths (files instead of directories)
  const notDirectories = results.filter((r) => r.exists && !r.isDirectory);
  if (notDirectories.length > 0) {
    if (notDirectories.length === 1) {
      console.error(
        chalk.red(
          `\n❌ ${contextForError} is not a directory: ${notDirectories[0].original}`
        )
      );
    } else {
      console.error(
        chalk.red(
          `\n❌ ${contextForError} are not directories:\n${notDirectories.map((p) => `   - ${p.original}`).join('\n')}`
        )
      );
    }
    console.error(
      chalk.yellow('\nPlease provide directory paths, not file paths.\n')
    );
    process.exit(1);
  }

  return results.map((r) => r.resolved);
}

/**
 * Validate and resolve context file path
 * Fails fast if file doesn't exist or is a directory
 *
 * @param path - Path to the context file (relative or absolute)
 * @param baseDir - Base directory for resolving relative paths
 * @returns Resolved path
 * @throws Error if file not found or path is a directory
 */
function validateContextFilePath(path: string, baseDir: string): string {
  const resolved = isAbsolute(path) ? path : resolve(baseDir, path);

  // Try to get file stats - handle I/O errors
  let stats;
  try {
    stats = statSync(resolved);
  } catch (error: unknown) {
    const isNotFound =
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT';
    if (isNotFound) {
      // Fail fast for explicitly provided paths that don't exist
      throw new Error(
        `Context file not found: ${path}. Please ensure the file exists.`
      );
    }
    // Re-throw other errors (e.g., permission issues) for main error handler
    throw error;
  }

  // Validate path is not a directory
  if (stats.isDirectory()) {
    console.error(chalk.red(`\n❌ Context path is a directory: ${path}`));
    console.error(
      chalk.yellow(
        '\nContext location must be a file (e.g., .ai/context.md), not a directory.\n'
      )
    );
    throw new Error('Invalid context path provided.');
  }

  // File exists and is valid - show success
  console.log(chalk.green(`  ✓ Context file exists: ${path}`));

  return resolved;
}

/**
 * Find VSCode workspace files in a directory
 * Checks both root and .vscode/ subdirectory (common locations)
 */
function findWorkspaceFiles(dir: string): string[] {
  const results: string[] = [];

  // Check root directory
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.endsWith('.code-workspace')) {
        results.push(join(dir, f));
      }
    }
  } catch {
    // Directory not readable, continue
  }

  // Check .vscode/ subdirectory
  const vscodeDir = join(dir, '.vscode');
  try {
    const files = readdirSync(vscodeDir);
    for (const f of files) {
      if (f.endsWith('.code-workspace')) {
        results.push(join(vscodeDir, f));
      }
    }
  } catch {
    // .vscode directory doesn't exist or not readable, continue
  }

  return results;
}

/**
 * Folder entry type - supports both string paths and {name, path} objects
 */
type FolderEntry = string | { name?: string; path: string };

/**
 * Merge folder sources with deduplication by resolved path
 * Preserves original structure (string vs object) of first occurrence
 *
 * @param sources Array of folder sources to merge, in priority order
 * @param baseDir Base directory for resolving relative paths
 * @returns Merged folders with duplicates removed
 */
function mergeFolders(
  sources: { folders: FolderEntry[]; label: string }[],
  baseDir: string
): { merged: FolderEntry[]; newFromLast: FolderEntry[] } {
  const folderMap = new Map<string, FolderEntry>();

  // Process all sources except last
  for (let i = 0; i < sources.length - 1; i++) {
    for (const folder of sources[i].folders) {
      const folderPath = typeof folder === 'string' ? folder : folder.path;
      const resolvedPath = isAbsolute(folderPath)
        ? folderPath
        : resolve(baseDir, folderPath);
      if (!folderMap.has(resolvedPath)) {
        folderMap.set(resolvedPath, folder);
      }
    }
  }

  // Track paths before adding last source (for identifying new additions)
  const pathsBeforeLast = new Set(folderMap.keys());

  // Process last source
  const lastSource = sources[sources.length - 1];
  if (lastSource) {
    for (const folder of lastSource.folders) {
      const folderPath = typeof folder === 'string' ? folder : folder.path;
      const resolvedPath = isAbsolute(folderPath)
        ? folderPath
        : resolve(baseDir, folderPath);
      if (!folderMap.has(resolvedPath)) {
        folderMap.set(resolvedPath, folder);
      }
    }
  }

  // Find new folders from last source
  const newFromLast = lastSource
    ? lastSource.folders.filter((folder) => {
        const folderPath = typeof folder === 'string' ? folder : folder.path;
        const resolvedPath = isAbsolute(folderPath)
          ? folderPath
          : resolve(baseDir, folderPath);
        return !pathsBeforeLast.has(resolvedPath);
      })
    : [];

  return {
    merged: Array.from(folderMap.values()),
    newFromLast,
  };
}

/**
 * Create default settings.json for project
 */
function createDefaultSettings(
  defaultBackend: BackendType,
  defaultFidelity: ExecutionFidelityLevel = 'standard',
  workspaceLocation?: string
): Partial<Settings> & { $schema: string } {
  return {
    $schema: './settings.schema.json',
    context_location: null,
    mcp_json_location: null,
    agents_md_location: null,
    pipelines_yaml_location: null,
    default_project_location: null,
    default_fidelity: defaultFidelity,
    default_backend: defaultBackend,
    workspace_location: workspaceLocation ?? null,
    env_file_location: null,
  };
}

export async function initCommand(options: InitOptions): Promise<void> {
  const logger = createLogger('init');

  // Capture user's current working directory at command start
  // This ensures we display the correct project path, not the package installation path
  const userProjectDir = process.cwd();

  // Display the branded banner
  const version = getPackageVersion();
  await displayBanner(version);

  try {
    // Clear settings cache first to ensure fresh state
    clearSettingsCache();

    // Handle --dotenv override (highest priority for env loading)
    // This must happen BEFORE backend detection so API keys are available
    // Note: We use --dotenv instead of --env-file to avoid collision with Node.js 20+ built-in --env-file
    if (options.dotenv) {
      const { config } = await import('dotenv');
      const envPath = expandPath(options.dotenv);

      if (!envPath || !existsSync(envPath) || statSync(envPath).isDirectory()) {
        console.error(
          chalk.red(
            `\n❌ Environment file not found or is a directory: ${options.dotenv}`
          )
        );
        process.exit(1);
      }

      const result = config({ path: envPath, override: true });
      if (result.error) {
        console.error(
          chalk.red(
            `\n❌ Failed to load environment file: ${result.error.message}`
          )
        );
        process.exit(1);
      }
      console.log(chalk.green(`✓ Loaded environment from: ${envPath}\n`));
    }

    // Step 0: Handle --reset flag (clear all state and cache)
    if (options.reset) {
      // Confirm before destructive operation
      const { confirmReset } = await inquirer.prompt<{ confirmReset: boolean }>(
        [
          {
            type: 'confirm',
            name: 'confirmReset',
            message:
              'This will delete all workflow state and circuit breaker data. Continue?',
            default: false,
          },
        ]
      );

      if (!confirmReset) {
        console.log(chalk.yellow('Reset cancelled.\n'));
        return;
      }

      console.log(chalk.bold('🗑️  Clearing cache and state files...\n'));

      // Clear legacy .agentos/state directory if it exists
      const legacyStatePath = join(userProjectDir, '.agentos', 'state');
      if (existsSync(legacyStatePath)) {
        rmSync(legacyStatePath, { recursive: true, force: true });
        console.log(chalk.green('  ✓ Cleared legacy .agentos/state directory'));
      }

      // Clear .airunx-state directory (workflows, circuit breaker, audit logs)
      const airunxStatePath = join(userProjectDir, '.airunx-state');
      if (existsSync(airunxStatePath)) {
        rmSync(airunxStatePath, { recursive: true, force: true });
        console.log(chalk.green('  ✓ Cleared .airunx-state directory'));
      }

      console.log();
    }

    // Step 1: Detect available backends
    const spinner = ora('Detecting available backends...').start();
    const validator = new BackendValidator();
    const available = await validator.validateBackends();

    spinner.stop();

    // Display availability
    console.log(chalk.bold('📊 Backend Availability:\n'));

    // Dynamically display all available backends
    const backends = Object.keys(available).sort();
    const displayNames = backends.map(toDisplayName);
    const maxLength = Math.max(...displayNames.map((name) => name.length));

    for (const backend of backends) {
      const status = available[backend as BackendType];
      const displayName = toDisplayName(backend).padEnd(maxLength + 2);
      if (status?.available) {
        console.log(
          chalk.green(`  ✓ ${displayName} ${status.version || ''}`.trim())
        );
      } else {
        console.log(chalk.red(`  ✗ ${displayName}`.trim()));
        if (status?.installInstructions) {
          console.log(chalk.dim(`     ${status.installInstructions}`));
        }
      }
    }
    console.log();

    // Check if at least one backend is available
    const availableBackends = Object.entries(available)
      .filter(([, status]) => status.available)
      .map(([name]) => name as BackendType);

    if (availableBackends.length === 0) {
      console.error(chalk.red('❌ No backends available!\n'));
      console.log(chalk.yellow('Quickest option to get started:'));
      console.log(chalk.cyan('  npm install -g @anthropic-ai/claude-code'));
      console.log(chalk.cyan('  export ANTHROPIC_API_KEY="your-key"\n'));
      process.exit(1);
    }

    // Step 2: Let user choose default backend
    const { defaultBackend } = await inquirer.prompt<{
      defaultBackend: BackendType;
    }>([
      {
        type: 'list',
        name: 'defaultBackend',
        message: 'Choose default backend:',
        choices: availableBackends.map((backend) => ({
          name: `${toDisplayName(backend)} ${available[backend]?.version ? `(${available[backend]?.version})` : ''}`,
          value: backend,
        })),
        default: availableBackends[0],
      },
    ]);

    // Step 3: Ask about fidelity level
    const costEstimates = getAllFidelityCostEstimates();
    const { defaultFidelity } = await inquirer.prompt<{
      defaultFidelity: ExecutionFidelityLevel;
    }>([
      {
        type: 'list',
        name: 'defaultFidelity',
        message: 'Select default fidelity level:',
        choices: EXECUTION_FIDELITY_LEVELS.map((level) => {
          const cost = costEstimates[level];
          const recommended = level === 'standard' ? ' [recommended]' : '';
          return {
            name: `${level.padEnd(FIDELITY_LEVEL_PADDING)} (~$${cost.toFixed(2)}/workflow, ${FIDELITY_DESCRIPTIONS[level]})${recommended}`,
            value: level,
          };
        }),
        default: 'standard',
      },
    ]);

    // Show fidelity info (using centralized FIDELITY_USE_CASES)
    console.log();
    console.log(chalk.dim('  Fidelity controls quality vs cost trade-offs:'));
    for (const level of EXECUTION_FIDELITY_LEVELS) {
      console.log(chalk.dim(`  - ${level}: ${FIDELITY_USE_CASES[level]}`));
    }
    console.log();

    // Step 3.5: Ask about customization
    const { customizeAgents } = await inquirer.prompt<{
      customizeAgents: boolean;
    }>([
      {
        type: 'confirm',
        name: 'customizeAgents',
        message: 'Create local AGENTS.md and pipelines.yaml for customization?',
        default: false,
      },
    ]);

    // Step 3.6: Ask about default project location
    const { configureProject } = await inquirer.prompt<{
      configureProject: boolean;
    }>([
      {
        type: 'confirm',
        name: 'configureProject',
        message:
          'Configure default project location? (For working on external projects)',
        default: false,
      },
    ]);

    let defaultProjectLocation: string | null = null;
    let defaultContextLocation: string | null = null;

    if (configureProject) {
      const projectPrompt = await inquirer.prompt<{
        projectLocation: string;
        contextLocation: string;
      }>([
        {
          type: 'input',
          name: 'projectLocation',
          message:
            'Default project directory (leave empty for current directory):',
          default: '',
        },
        {
          type: 'input',
          name: 'contextLocation',
          message: 'Default context file path (e.g., .ai/context.md):',
          default: '.ai/context.md',
        },
      ]);

      if (projectPrompt.projectLocation.trim()) {
        const relativePath = projectPrompt.projectLocation.trim();
        // Validate and resolve to absolute path for consistent runtime resolution
        [defaultProjectLocation] = validateAndResolvePaths(
          [relativePath],
          'Default project location',
          userProjectDir
        );
      }
      if (projectPrompt.contextLocation.trim()) {
        const contextPath = projectPrompt.contextLocation.trim();
        // Validate context file exists and is not a directory (fails fast if invalid)
        // Resolve relative to the configured project location, not cwd
        defaultContextLocation = validateContextFilePath(
          contextPath,
          defaultProjectLocation || userProjectDir
        );
      }
    }

    // Step 3.7: Ask about additional project folders for multi-project workspace
    // FolderEntry type preserves {name, path} objects from workspace imports
    let projectFolders: FolderEntry[] | null = null;
    if (configureProject) {
      const projectFoldersPrompt = await inquirer.prompt<{
        projectFolders: string;
      }>([
        {
          type: 'input',
          name: 'projectFolders',
          message:
            'Additional project folders (comma-separated paths, or leave empty):',
          default: '',
        },
      ]);

      if (projectFoldersPrompt.projectFolders.trim()) {
        const relativePaths = projectFoldersPrompt.projectFolders
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);

        // Validate and resolve to absolute paths for consistent runtime resolution
        projectFolders = validateAndResolvePaths(
          relativePaths,
          'Project folder paths',
          userProjectDir
        );
      }

      // Step 3.8: Auto-detect VSCode workspace files and offer to import
      // Scan default project location if specified, otherwise current project dir
      const workspaceScanDir = defaultProjectLocation || userProjectDir;
      const workspaceFiles = findWorkspaceFiles(workspaceScanDir);
      if (workspaceFiles.length > 0) {
        const workspaceFile = workspaceFiles[0]; // Use first found
        const relativePath = relative(workspaceScanDir, workspaceFile);

        const { importWorkspace } = await inquirer.prompt<{
          importWorkspace: boolean;
        }>([
          {
            type: 'confirm',
            name: 'importWorkspace',
            message: `Found VSCode workspace: ${relativePath}. Import folders from it?`,
            default: true,
          },
        ]);

        if (importWorkspace) {
          try {
            const workspaceFolders = parseWorkspaceFolders(workspaceFile);
            if (workspaceFolders.length > 0) {
              // Load existing folders from settings.json if it exists
              const existingSettingsPath = join(
                userProjectDir,
                '.airunx',
                'settings.json'
              );
              let existingFolders: FolderEntry[] = [];
              if (existsSync(existingSettingsPath)) {
                try {
                  const existing = parseJsonc(
                    readFileSync(existingSettingsPath, 'utf-8')
                  ) as Partial<Settings> | undefined;
                  existingFolders = existing?.folders || [];
                } catch {
                  // Ignore parse errors, start fresh
                }
              }

              // Merge: existing settings + prompt folders + workspace folders
              const { merged, newFromLast } = mergeFolders(
                [
                  { folders: existingFolders, label: 'existing' },
                  { folders: projectFolders || [], label: 'prompts' },
                  { folders: workspaceFolders, label: 'workspace' },
                ],
                userProjectDir
              );

              // Update projectFolders with merged result (preserving {name, path} objects)
              projectFolders = merged;

              if (newFromLast.length > 0) {
                console.log(
                  chalk.green(
                    `  ✓ Imported ${newFromLast.length} folder(s) from workspace`
                  )
                );
              } else {
                console.log(
                  chalk.yellow('  ⚠ All workspace folders already added')
                );
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.log(
              chalk.yellow(`  ⚠ Could not parse workspace file: ${message}`)
            );
          }
        }
      }
    }

    // Step 4: Create .airunx directory and check for existing config
    const airunxDir = join(userProjectDir, '.airunx');
    if (!existsSync(airunxDir)) {
      mkdirSync(airunxDir, { recursive: true });
    }

    const settingsFile = join(airunxDir, 'settings.json');
    const configFile = join(airunxDir, 'config.yml');
    const settingsFileExists = existsSync(settingsFile);
    const packageDefaultDir = getPackageDefaultDir();

    // Step 5: Handle --from-workspace as update operation (merge with existing)
    if (options.fromWorkspace) {
      const workspacePath = isAbsolute(options.fromWorkspace)
        ? options.fromWorkspace
        : resolve(userProjectDir, options.fromWorkspace);

      if (!existsSync(workspacePath)) {
        console.error(
          chalk.red(`\n❌ Workspace file not found: ${options.fromWorkspace}`)
        );
        process.exit(1);
      }

      try {
        const workspaceFolders = parseWorkspaceFolders(workspacePath);
        console.log(
          chalk.bold(
            `\n📂 Importing folders from workspace: ${options.fromWorkspace}`
          )
        );

        // Load existing settings if they exist
        let existingSettings: Partial<Settings> = {};
        if (settingsFileExists) {
          try {
            existingSettings =
              (parseJsonc(
                readFileSync(settingsFile, 'utf-8')
              ) as Partial<Settings>) || {};
          } catch {
            console.log(
              chalk.yellow(
                '  ⚠ Could not parse existing settings, starting fresh'
              )
            );
          }
        }

        // Backup existing settings before modification (with timestamp to prevent overwrites)
        if (settingsFileExists) {
          const backupPath = `${settingsFile}.backup.${Date.now()}`;
          copyFileSync(settingsFile, backupPath);
          console.log(
            chalk.dim(`  ℹ Backed up existing settings to ${backupPath}`)
          );
        }

        // Merge: existing settings + prompt folders + workspace folders
        // Resolve relative paths from settings file location, not cwd
        const settingsDir = join(settingsFile, '..');
        const { merged: mergedFolders, newFromLast: newFolders } = mergeFolders(
          [
            { folders: existingSettings.folders || [], label: 'existing' },
            { folders: projectFolders || [], label: 'prompts' },
            { folders: workspaceFolders, label: 'workspace' },
          ],
          settingsDir
        );

        if (newFolders.length > 0) {
          console.log(
            chalk.green(
              `  ✓ Added ${newFolders.length} folder(s) from workspace`
            )
          );
          for (const folder of newFolders) {
            const folderPath =
              typeof folder === 'string' ? folder : folder.path;
            console.log(chalk.dim(`    - ${folderPath}`));
          }
        } else {
          console.log(
            chalk.yellow('  ⚠ All workspace folders already exist in settings')
          );
        }

        // Update settings with merged folders
        const updatedSettings = {
          ...existingSettings,
          folders: mergedFolders,
        };

        writeFileSync(settingsFile, JSON.stringify(updatedSettings, null, 2));
        console.log(chalk.green('✓ Updated .airunx/settings.json'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          chalk.red(`\n❌ Failed to parse workspace file: ${message}`)
        );
        process.exit(1);
      }
    } else if (settingsFileExists && !options.force) {
      // Step 5b: Normal init without --from-workspace
      console.log(
        chalk.yellow(
          '⚠ settings.json already exists, use --force to overwrite'
        )
      );
    } else {
      // Step 5c: Create new settings.json
      // Create backup if overwriting existing file
      if (settingsFileExists && options.force) {
        const backupFilename = `settings.bak.${Date.now()}.json`;
        copyFileSync(settingsFile, join(airunxDir, backupFilename));
        console.log(
          chalk.dim(`  Backed up existing settings to ${backupFilename}`)
        );
      }

      // Build settings object with customization paths if requested
      const settings = createDefaultSettings(
        defaultBackend,
        defaultFidelity,
        options.workspace
      );
      if (customizeAgents) {
        settings.agents_md_location = './AGENTS.md';
        settings.pipelines_yaml_location = './pipelines.yaml';
      }
      // Add project and context locations if configured
      if (defaultProjectLocation) {
        settings.default_project_location = defaultProjectLocation;
      }
      if (defaultContextLocation) {
        settings.context_location = defaultContextLocation;
      }
      // Persist --dotenv path so `run` picks it up via loadEnvironment()
      if (options.dotenv) {
        const expanded = expandPath(options.dotenv);
        if (expanded) {
          const absolutePath = isAbsolute(expanded)
            ? expanded
            : resolve(userProjectDir, expanded);
          if (!existsSync(absolutePath)) {
            console.error(
              chalk.red(
                `\n❌ Cannot persist dotenv path — file does not exist: ${absolutePath}`
              )
            );
            process.exit(1);
          }
          settings.env_file_location = absolutePath;
        }
      }
      // Add project folders for multi-project workspace support
      if (projectFolders && projectFolders.length > 0) {
        settings.folders = projectFolders;
      }
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      console.log(chalk.green('✓ Created .airunx/settings.json'));
    }

    // Step 6: Copy schema file for IDE support
    const schemaFile = join(airunxDir, 'settings.schema.json');
    const sourceSchemaFile = join(packageDefaultDir, 'settings.schema.json');
    if (
      existsSync(sourceSchemaFile) &&
      (!existsSync(schemaFile) || options.force)
    ) {
      copyFileSync(sourceSchemaFile, schemaFile);
      console.log(chalk.green('✓ Created .airunx/settings.schema.json'));
    }

    // Step 7: Create system config
    if (existsSync(configFile) && !options.force) {
      console.log(
        chalk.yellow('⚠ config.yml already exists, use --force to overwrite')
      );
    } else {
      // Create backup if overwriting existing file
      if (existsSync(configFile) && options.force) {
        const backupFilename = `config.bak.${Date.now()}.yml`;
        copyFileSync(configFile, join(airunxDir, backupFilename));
        console.log(
          chalk.dim(`  Backed up existing config to ${backupFilename}`)
        );
      }
      const config = generateDefaultConfig(defaultBackend);
      saveSystemConfig(config, configFile);
      console.log(chalk.green('✓ Created .airunx/config.yml'));
    }

    // Step 8: Optionally copy AGENTS.md and pipelines.yaml for customization
    if (customizeAgents) {
      copyOptionalFile(
        join(packageDefaultDir, 'AGENTS.md'),
        join(airunxDir, 'AGENTS.md'),
        options.force ?? false,
        '✓ Created .airunx/AGENTS.md'
      );
      copyOptionalFile(
        join(packageDefaultDir, 'pipelines.yaml'),
        join(airunxDir, 'pipelines.yaml'),
        options.force ?? false,
        '✓ Created .airunx/pipelines.yaml'
      );
    }

    // Step 8.5: Validate AGENTS.md if it exists
    // Use shared utility for consistent path resolution
    const initSettings = loadSettings(userProjectDir);
    const agentsMdPath = resolveAgentsMdPath(undefined, initSettings);

    if (agentsMdPath) {
      console.log(chalk.bold('\n🔍 Validating AGENTS.md...\n'));

      const validationResult = await validateAgentsMdWithConfirmation(
        agentsMdPath,
        {
          interactive: !options.force, // --force skips interactive prompts
          fix: options.force ?? false, // --force auto-applies fixes
          costWarnings: true,
          mode: 'lenient', // Use warnings instead of errors during init
        }
      );

      // Display validation results
      formatAgentsValidationResult(validationResult);

      if (validationResult.fixesApplied.length > 0) {
        console.log(
          chalk.green(
            `\n✓ Applied ${validationResult.fixesApplied.length} fix(es) to AGENTS.md`
          )
        );
      }

      if (!validationResult.valid) {
        console.log(
          chalk.yellow(
            '\n⚠ AGENTS.md has validation issues. Run `airunx agents-validate --fix` to resolve them.'
          )
        );
      } else if (validationResult.issues.length === 0) {
        console.log(chalk.green('✓ AGENTS.md validation passed'));
      }
    }

    // Step 9: Check for legacy config files and offer migration hint
    // Only warn if there are actual config files to migrate, not just state directories
    const legacyConfigFiles = [
      join(userProjectDir, '.agents', 'AGENTS.md'),
      join(userProjectDir, '.agents', 'pipelines.yaml'),
      join(userProjectDir, '.agents', 'config.yml'),
      join(userProjectDir, '.agentos', 'AGENTS.md'),
      join(userProjectDir, '.agentos', 'pipelines.yaml'),
      join(userProjectDir, '.agentos', 'config.yml'),
    ];
    const foundLegacyConfigs = legacyConfigFiles.filter((f) => existsSync(f));
    if (foundLegacyConfigs.length > 0) {
      console.log();
      console.log(chalk.yellow('⚠ Legacy config files detected:'));
      for (const configPath of foundLegacyConfigs) {
        console.log(chalk.dim(`  - ${relative(userProjectDir, configPath)}`));
      }
      console.log(
        chalk.dim('  These will still work but consider migrating to .airunx/')
      );
    }

    // Success message
    console.log(chalk.bold.green('\n✓ Project initialized successfully!\n'));

    // Show config hierarchy info with existence indicators and project info
    clearSettingsCache(); // Clear cache to load fresh settings after init
    const currentSettings = loadSettings(userProjectDir);
    displayConfigHierarchy(currentSettings, { projectDir: userProjectDir });

    console.log(chalk.dim('Next steps:'));
    if (customizeAgents) {
      console.log(
        chalk.dim('  1. Edit .airunx/AGENTS.md to customize agent roles')
      );
      console.log(
        chalk.dim('  2. Edit .airunx/pipelines.yaml to customize pipelines')
      );
    } else {
      console.log(chalk.dim('  1. Using default AGENTS.md and pipelines.yaml'));
      console.log(
        chalk.dim(
          '     Run `airunx init --force` with customization to create local copies'
        )
      );
    }
    console.log(
      chalk.dim('  3. Configure MCP servers in settings.json if needed')
    );
    console.log(chalk.dim('  4. Run: airunx run <input>\n'));
  } catch (error) {
    handleCommandError(error, logger, 'Initialization');
    process.exit(1);
  }
}
