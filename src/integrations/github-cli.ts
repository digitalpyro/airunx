/**
 * GitHub CLI integration
 * Wraps gh CLI commands for issue/PR operations
 */

import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const logger = createLogger('github-cli');

/**
 * Execute a command with stdin input using spawn.
 * Used when we need to pipe data to a command's stdin (e.g., gh api --input -).
 */
function execWithStdin(
  command: string,
  args: string[],
  stdinData: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Command failed with code ${code}: ${stderr}`);
        reject(error);
      }
    });

    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/**
 * Internal interfaces for GitHub CLI JSON responses
 * These match the structure returned by `gh` commands with `--json` flag
 */
interface GhLabel {
  name: string;
  color: string;
  description: string;
}

interface GhAuthor {
  login: string;
  id: number;
}

interface GhIssueData {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: GhLabel[];
  author: GhAuthor;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface GhPullRequestData extends GhIssueData {
  baseRefName: string;
  headRefName: string;
}

interface GhRepoData {
  nameWithOwner: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  author: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Normalize a git remote URL to owner/repo format.
 * Handles SSH, HTTPS, and token-authenticated URLs:
 *   git@github.com:owner/repo.git -> owner/repo
 *   https://github.com/owner/repo.git -> owner/repo
 *   https://x-access-token:TOKEN@github.com/owner/repo.git -> owner/repo
 */
export function normalizeGitRemoteUrl(remote: string): string {
  return remote
    .replace(/^git@github\.com:/, '')
    .replace(/^https:\/\/[^@]*@?github\.com\//, '')
    .replace(/\.git$/, '');
}

/**
 * Check if gh CLI is available in PATH (cached after first check)
 */
let ghCliAvailable: boolean | null = null;
async function isGhAvailable(): Promise<boolean> {
  if (ghCliAvailable !== null) return ghCliAvailable;
  try {
    await execAsync('which gh');
    ghCliAvailable = true;
  } catch {
    ghCliAvailable = false;
  }
  return ghCliAvailable;
}

/**
 * Make a GitHub REST API request using GITHUB_TOKEN / GH_TOKEN.
 * Falls back when gh CLI is not installed.
 */
async function githubApi(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const token =
    process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN or GH_TOKEN required for GitHub API fallback (gh CLI not installed)'
    );
  }

  const url = `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AIRunX',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub API ${method} ${path} failed (${response.status}): ${text}`
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return {};
}

/**
 * Make a GitHub REST API request that returns plain text (e.g., job logs).
 * Follows redirects automatically (the logs endpoint returns 302).
 */
async function githubApiText(path: string): Promise<string> {
  const token =
    process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN required for GitHub API');
  }

  const url = `https://api.github.com${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AIRunX',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`GitHub API GET ${path} failed (${response.status})`);
  }

  return response.text();
}

/**
 * Zod schema for GitHub Actions workflow run (from `gh run list --json`)
 */
const WorkflowRunSchema = z.object({
  databaseId: z.number(),
  headSha: z.string(),
  status: z.enum([
    'queued',
    'in_progress',
    'completed',
    'requested',
    'waiting',
    'pending',
  ]),
  conclusion: z
    .enum([
      'success',
      'failure',
      'cancelled',
      'neutral',
      'skipped',
      'stale',
      'startup_failure',
      'timed_out',
      'action_required',
    ])
    .nullable()
    .or(z.literal('').transform(() => null)),
  workflowName: z.string(),
  url: z.string(),
  event: z.string(),
});

export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/**
 * Zod schema for GitHub REST API pull request response
 */
const GitHubApiPullRequestSchema = z.object({
  number: z.number(),
  title: z.string().default(''),
  body: z.string().nullable().default(null),
  state: z.string().default('open'),
  labels: z.array(z.object({ name: z.string() }).passthrough()).default([]),
  user: z.object({ login: z.string() }).nullable().default(null),
  base: z.object({ ref: z.string() }).nullable().default(null),
  head: z.object({ ref: z.string() }).nullable().default(null),
  html_url: z.string().default(''),
  created_at: z.string().default(''),
  updated_at: z.string().default(''),
});

/**
 * Parse GitHub REST API PR response into our GitHubPullRequest type
 */
function parsePullRequestFromApi(data: unknown): GitHubPullRequest {
  const parsed = GitHubApiPullRequestSchema.parse(data);
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body || '',
    state: parsed.state.toLowerCase() as 'open' | 'closed' | 'merged',
    labels: parsed.labels.map((l) => l.name),
    author: parsed.user?.login || 'unknown',
    url: parsed.html_url,
    baseBranch: parsed.base?.ref || '',
    headBranch: parsed.head?.ref || '',
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

export class GitHubCLI {
  private static configured = false;

  /**
   * Add a comment to a PR with debug/run summary information
   */
  static async addPRComment(options: {
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    await this.configure();

    const args = [
      'pr',
      'comment',
      String(options.prNumber),
      '--repo',
      options.repo,
      '--body',
      options.body,
    ];

    logger.debug(
      `[GH] gh pr comment ${options.prNumber} --repo ${options.repo}`
    );
    logger.debug('[GH] Comment body length:', options.body.length);
    await execFileAsync('gh', args);
    logger.debug(`[GH] Successfully added comment to PR #${options.prNumber}`);
  }

  /**
   * Update a PR's body to include additional information
   * Appends to existing body rather than replacing
   */
  static async appendToPRBody(options: {
    repo: string;
    prNumber: number;
    appendContent: string;
  }): Promise<void> {
    await this.configure();

    logger.info(`[GH] Appending content to PR #${options.prNumber} body`);
    logger.debug('[GH] Append content length:', options.appendContent.length);

    // First get the current PR body
    const pr = await this.getPullRequest(options.repo, options.prNumber);
    const newBody = pr.body
      ? `${pr.body}\n\n---\n\n${options.appendContent}`
      : options.appendContent;

    const args = [
      'pr',
      'edit',
      String(options.prNumber),
      '--repo',
      options.repo,
      '--body',
      newBody,
    ];

    await execFileAsync('gh', args);
    logger.info(`[GH] Successfully appended to PR #${options.prNumber} body`);
  }

  /**
   * Update a PR's title and/or body (replaces entirely)
   */
  static async updatePullRequest(options: {
    repo: string;
    prNumber: number;
    title?: string;
    body?: string;
  }): Promise<void> {
    // If no updates are provided, do nothing
    if (options.title === undefined && options.body === undefined) {
      logger.debug('[GH] updatePullRequest called with no updates, skipping');
      return;
    }

    logger.info(`[GH] Updating PR #${options.prNumber} in ${options.repo}`);

    // Try gh CLI first
    if (await isGhAvailable()) {
      const args = [
        'pr',
        'edit',
        String(options.prNumber),
        '--repo',
        options.repo,
      ];
      if (options.title !== undefined) args.push('--title', options.title);
      if (options.body !== undefined) args.push('--body', options.body);

      await this.configure();
      logger.debug('[GH] PR update details', {
        prNumber: options.prNumber,
        hasTitle: options.title !== undefined,
        hasBody: options.body !== undefined,
        titlePreview: options.title?.slice(0, 50),
      });
      await execFileAsync('gh', args);
      logger.info(`[GH] Successfully updated PR #${options.prNumber}`);
      return;
    }

    // Fallback: GitHub REST API
    const [owner, repoName] = options.repo.split('/');
    const updates: Record<string, unknown> = {};
    if (options.title !== undefined) updates.title = options.title;
    if (options.body !== undefined) updates.body = options.body;

    await githubApi(
      'PATCH',
      `/repos/${owner}/${repoName}/pulls/${options.prNumber}`,
      updates
    );
    logger.info(`[GH] Successfully updated PR #${options.prNumber} (REST API)`);
  }

  /**
   * Create a PR with debug summary included in the body
   */
  static async createPullRequestWithDebugInfo(options: {
    repo: string;
    title: string;
    body: string;
    base?: string;
    head?: string;
    debugSummary?: string;
  }): Promise<GitHubPullRequest> {
    const bodyWithDebug = options.debugSummary
      ? `${options.body}\n\n---\n\n${options.debugSummary}`
      : options.body;

    return this.createPullRequest({
      ...options,
      body: bodyWithDebug,
    });
  }

  /**
   * Add a comment to an issue with debug/error information
   */
  static async addIssueComment(options: {
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<void> {
    await this.configure();

    logger.debug(
      `[GH] Adding comment to issue #${options.issueNumber} in ${options.repo}`
    );
    logger.debug('[GH] Comment body length:', options.body.length);

    if (await isGhAvailable()) {
      await execFileAsync('gh', [
        'issue',
        'comment',
        String(options.issueNumber),
        '--repo',
        options.repo,
        '--body',
        options.body,
      ]);
    } else {
      await githubApi(
        'POST',
        `/repos/${options.repo}/issues/${options.issueNumber}/comments`,
        { body: options.body }
      );
    }
    logger.debug(
      `[GH] Successfully added comment to issue #${options.issueNumber}`
    );
  }

  /**
   * Check if gh CLI is installed and authenticated
   */
  static async isAvailable(): Promise<{
    available: boolean;
    authMethod?: 'token' | 'token-only' | 'gh-cli';
    error?: string;
  }> {
    const token =
      process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();

    // Check if gh is in PATH
    const ghInstalled = await isGhAvailable();

    if (ghInstalled) {
      // gh CLI found — use token if available, otherwise check gh auth
      if (token) {
        return { available: true, authMethod: 'token' };
      }

      try {
        await execAsync('gh auth status');
        return { available: true, authMethod: 'gh-cli' };
      } catch {
        return {
          available: false,
          error: 'Set GITHUB_TOKEN or run: gh auth login',
        };
      }
    }

    // No gh CLI — fall back to token-only REST API mode
    if (token) {
      logger.info(
        '[GH] gh CLI not found, using REST API with token authentication'
      );
      return { available: true, authMethod: 'token-only' };
    }

    return {
      available: false,
      error:
        'GitHub access requires either: (1) gh CLI installed (https://cli.github.com), or (2) GITHUB_TOKEN / GH_TOKEN environment variable',
    };
  }

  /**
   * Configure gh CLI to avoid interactive prompts
   * Only runs once per application lifecycle to avoid redundant process calls
   */
  static async configure(): Promise<void> {
    if (this.configured) {
      return;
    }
    this.configured = true;

    const token =
      process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
    if (token) {
      logger.debug('[GH] Using token authentication');
    } else {
      logger.debug('[GH] Using gh CLI credentials');
    }

    // Only configure gh CLI settings if binary is available
    if (await isGhAvailable()) {
      try {
        // Set pager to cat to avoid hanging
        await execAsync('gh config set pager cat');
      } catch {
        // Non-critical, continue
      }
    }
  }

  /**
   * Get issue details
   */
  static async getIssue(
    repo: string,
    issueNumber: number
  ): Promise<GitHubIssue> {
    await this.configure();

    if (await isGhAvailable()) {
      const { stdout } = await execFileAsync('gh', [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'number,title,body,state,labels,author,url,createdAt,updatedAt',
      ]);

      const data: GhIssueData = JSON.parse(stdout);

      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        state: data.state.toLowerCase() as 'open' | 'closed',
        labels: data.labels?.map((l) => l.name) || [],
        author: data.author?.login || 'unknown',
        url: data.url,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    }

    // REST API fallback
    const data = (await githubApi(
      'GET',
      `/repos/${repo}/issues/${issueNumber}`
    )) as Record<string, unknown>;

    const labels = Array.isArray(data.labels)
      ? (data.labels as Array<{ name: string }>).map((l) => l.name)
      : [];
    const author =
      typeof data.user === 'object' && data.user !== null
        ? ((data.user as Record<string, unknown>).login as string) || 'unknown'
        : 'unknown';

    return {
      number: data.number as number,
      title: data.title as string,
      body: (data.body as string) || '',
      state: ((data.state as string) || 'open').toLowerCase() as
        | 'open'
        | 'closed',
      labels,
      author,
      url: (data.html_url as string) || '',
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
  }

  /**
   * Get pull request details
   */
  static async getPullRequest(
    repo: string,
    prNumber: number
  ): Promise<GitHubPullRequest> {
    // Try gh CLI first
    if (await isGhAvailable()) {
      await this.configure();
      const { stdout } = await execFileAsync('gh', [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'number,title,body,state,labels,author,url,baseRefName,headRefName,createdAt,updatedAt',
      ]);
      const data: GhPullRequestData = JSON.parse(stdout);
      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        state: data.state.toLowerCase() as 'open' | 'closed' | 'merged',
        labels: data.labels?.map((l) => l.name) || [],
        author: data.author?.login || 'unknown',
        url: data.url,
        baseBranch: data.baseRefName,
        headBranch: data.headRefName,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    }

    // Fallback: GitHub REST API
    const [owner, repoName] = repo.split('/');
    const data = (await githubApi(
      'GET',
      `/repos/${owner}/${repoName}/pulls/${prNumber}`
    )) as Record<string, unknown>;
    return parsePullRequestFromApi(data);
  }

  /**
   * List pull requests
   */
  static async listPullRequests(
    repo: string,
    options: {
      head?: string;
      state?: 'open' | 'closed' | 'all';
      limit?: number;
    } = {}
  ): Promise<GitHubPullRequest[]> {
    logger.debug(`[GH] Listing PRs for ${repo}`, {
      state: options.state || 'open',
      head: options.head,
      limit: options.limit || 30,
    });

    // Try gh CLI first
    if (await isGhAvailable()) {
      await this.configure();
      const args = [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        options.state || 'open',
        '--limit',
        String(options.limit || 30),
      ];
      if (options.head) args.push('--head', options.head);
      args.push(
        '--json',
        'number,title,body,state,labels,author,url,baseRefName,headRefName,createdAt,updatedAt'
      );

      const { stdout } = await execFileAsync('gh', args);
      const data: GhPullRequestData[] = JSON.parse(stdout);
      logger.debug(`[GH] Found ${data.length} PRs`);
      return data.map((item) => ({
        number: item.number,
        title: item.title,
        body: item.body || '',
        state: item.state.toLowerCase() as 'open' | 'closed' | 'merged',
        labels: item.labels?.map((l) => l.name) || [],
        author: item.author?.login || 'unknown',
        url: item.url,
        baseBranch: item.baseRefName,
        headBranch: item.headRefName,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
    }

    // Fallback: GitHub REST API
    const [owner, repoName] = repo.split('/');
    const state = options.state === 'all' ? 'all' : options.state || 'open';
    let query = `/repos/${owner}/${repoName}/pulls?state=${state}&per_page=${options.limit || 30}`;
    if (options.head) {
      // REST API expects head in "owner:branch" format
      query += `&head=${owner}:${options.head}`;
    }

    const data = (await githubApi('GET', query)) as Array<
      Record<string, unknown>
    >;
    logger.debug(`[GH] Found ${data.length} PRs (REST API)`);
    return data.map(parsePullRequestFromApi);
  }

  /**
   * List issues
   */
  static async listIssues(
    repo: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      limit?: number;
      labels?: string[];
    } = {}
  ): Promise<GitHubIssue[]> {
    await this.configure();

    if (await isGhAvailable()) {
      const args = [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        options.state || 'open',
        '--limit',
        String(options.limit || 30),
      ];

      if (options.labels && options.labels.length > 0) {
        args.push('--label', options.labels.join(','));
      }

      args.push(
        '--json',
        'number,title,body,state,labels,author,url,createdAt,updatedAt'
      );

      const { stdout } = await execFileAsync('gh', args);
      const data: GhIssueData[] = JSON.parse(stdout);

      return data.map((item) => ({
        number: item.number,
        title: item.title,
        body: item.body || '',
        state: item.state.toLowerCase() as 'open' | 'closed',
        labels: item.labels?.map((l) => l.name) || [],
        author: item.author?.login || 'unknown',
        url: item.url,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
    } else {
      // REST API fallback
      const params = new URLSearchParams();
      params.set('state', options.state || 'open');
      params.set('per_page', String(options.limit || 30));
      if (options.labels && options.labels.length > 0) {
        params.set('labels', options.labels.join(','));
      }

      const data = (await githubApi(
        'GET',
        `/repos/${repo}/issues?${params.toString()}`
      )) as Array<{
        number: number;
        title: string;
        body: string | null;
        state: string;
        labels: { name: string }[];
        user: { login: string } | null;
        html_url: string;
        created_at: string;
        updated_at: string;
        pull_request?: unknown;
      }>;

      // Filter out pull requests (GitHub API returns PRs in issues endpoint)
      return data
        .filter((item) => !item.pull_request)
        .map((item) => ({
          number: item.number,
          title: item.title,
          body: item.body || '',
          state: item.state as 'open' | 'closed',
          labels: item.labels?.map((l) => l.name) || [],
          author: item.user?.login || 'unknown',
          url: item.html_url,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        }));
    }
  }

  /**
   * Create a pull request
   * Note: gh pr create doesn't support --json, so we create first then fetch details
   */
  static async createPullRequest(options: {
    repo: string;
    title: string;
    body: string;
    base?: string;
    head?: string;
    cwd?: string;
  }): Promise<GitHubPullRequest> {
    logger.info(`[GH] Creating PR for ${options.repo}`);
    logger.debug('[GH] PR creation details', {
      repo: options.repo,
      title: options.title,
      base: options.base,
      head: options.head,
      cwd: options.cwd,
      bodyLength: options.body.length,
    });

    // Try gh CLI first
    if (await isGhAvailable()) {
      await this.configure();
      const args = [
        'pr',
        'create',
        '--repo',
        options.repo,
        '--title',
        options.title,
        '--body',
        options.body,
      ];
      if (options.base) args.push('--base', options.base);
      if (options.head) args.push('--head', options.head);

      const { stdout } = await execFileAsync('gh', args, { cwd: options.cwd });
      const prUrl = stdout.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch) {
        throw new Error(`Could not parse PR number from URL: ${prUrl}`);
      }
      const prNumber = parseInt(prMatch[1], 10);
      logger.info(`[GH] Created PR #${prNumber}: ${prUrl}`);
      return this.getPullRequest(options.repo, prNumber);
    }

    // Fallback: GitHub REST API
    logger.info('[GH] gh CLI not available, using GitHub REST API');
    const [owner, repo] = options.repo.split('/');

    // Determine base branch if not provided
    let base = options.base;
    if (!base) {
      const repoData = (await githubApi('GET', `/repos/${owner}/${repo}`)) as {
        default_branch: string;
      };
      base = repoData.default_branch;
    }

    const prData = (await githubApi('POST', `/repos/${owner}/${repo}/pulls`, {
      title: options.title,
      body: options.body,
      head: options.head || '',
      base,
    })) as Record<string, unknown>;

    const result = parsePullRequestFromApi(prData);
    logger.info(`[GH] Created PR #${result.number}: ${result.url}`);
    return result;
  }

  /**
   * Apply labels to a PR
   * Note: `gh pr edit --add-label` automatically creates labels that don't exist
   */
  static async applyLabels(
    repo: string,
    prNumber: number,
    labels: string[]
  ): Promise<void> {
    if (labels.length === 0) {
      logger.debug('[GH] applyLabels called with no labels, skipping');
      return;
    }

    logger.debug('[GH] Labels to apply:', labels);

    // Try gh CLI first
    if (await isGhAvailable()) {
      await this.configure();
      const args = [
        'pr',
        'edit',
        String(prNumber),
        '--repo',
        repo,
        ...labels.flatMap((label) => ['--add-label', label]),
      ];
      await execFileAsync('gh', args);
      logger.debug(
        `[GH] Successfully applied ${labels.length} labels to PR #${prNumber}`
      );
      return;
    }

    // Fallback: GitHub REST API
    const [owner, repoName] = repo.split('/');
    await githubApi(
      'POST',
      `/repos/${owner}/${repoName}/issues/${prNumber}/labels`,
      { labels }
    );
    logger.debug(
      `[GH] Successfully applied ${labels.length} labels to PR #${prNumber} (REST API)`
    );
  }

  /**
   * Get current repository from git remote
   * @param cwd - Optional working directory (e.g., worktree path)
   */
  static async getCurrentRepo(cwd?: string): Promise<string | null> {
    // Try gh CLI first
    if (await isGhAvailable()) {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['repo', 'view', '--json', 'nameWithOwner'],
          { cwd }
        );
        const data: GhRepoData = JSON.parse(stdout);
        return data.nameWithOwner;
      } catch {
        // Fall through to git remote parsing
      }
    }

    // Fallback: parse git remote origin URL
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['config', '--get', 'remote.origin.url'],
        { cwd }
      );
      const remote = stdout.trim();
      const normalized = normalizeGitRemoteUrl(remote);
      const parts = normalized.split('/');
      if (parts.length === 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    } catch {
      // Fall through
    }
    return null;
  }

  /**
   * Parse GitHub URL to extract repo and issue/PR number
   */
  static parseGitHubUrl(
    url: string
  ):
    | { repo: string; type: 'issue' | 'pr'; number: number }
    | { repo: string; type: 'repo'; number: undefined }
    | null {
    // Match: https://github.com/owner/repo/issues/123
    // Match: https://github.com/owner/repo/pull/456
    const issueMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    const prMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);

    if (issueMatch) {
      return {
        repo: issueMatch[1],
        type: 'issue',
        number: parseInt(issueMatch[2], 10),
      };
    }

    if (prMatch) {
      return {
        repo: prMatch[1],
        type: 'pr',
        number: parseInt(prMatch[2], 10),
      };
    }

    // Match plain repo URLs: https://github.com/owner/repo[.git]
    // Extract the URL from the string, then use URL API for robust parsing
    const urlMatch = url.match(/https?:\/\/github\.com\/[^\s]+/);
    if (urlMatch) {
      try {
        const parsed = new URL(urlMatch[0]);
        if (parsed.hostname === 'github.com') {
          const segments = parsed.pathname
            .replace(/\/+$/, '')
            .replace(/\.git$/, '')
            .split('/')
            .filter(Boolean);
          if (segments.length === 2) {
            return {
              repo: `${segments[0]}/${segments[1]}`,
              type: 'repo',
              number: undefined,
            };
          }
        }
      } catch {
        // Invalid URL, fall through to return null
      }
    }

    return null;
  }

  // ============================================================
  // Heartbeat Task Queue Methods
  // ============================================================

  /**
   * Assign an issue to a user
   * Used for atomic checkout in heartbeat task queue
   */
  static async assignIssue(
    repo: string,
    issueNumber: string,
    user: string
  ): Promise<void> {
    await this.configure();

    if (await isGhAvailable()) {
      const args = [
        'issue',
        'edit',
        issueNumber,
        '--repo',
        repo,
        '--add-assignee',
        user,
      ];

      logger.debug(
        `[GH] gh issue edit ${issueNumber} --repo ${repo} --add-assignee ${user}`
      );
      await execFileAsync('gh', args);
    } else {
      logger.debug(`[GH] REST API: assign issue #${issueNumber} to ${user}`);
      await githubApi(
        'POST',
        `/repos/${repo}/issues/${issueNumber}/assignees`,
        { assignees: [user] }
      );
    }
    logger.debug(`[GH] Successfully assigned issue #${issueNumber} to ${user}`);
  }

  /**
   * Unassign a user from an issue
   * Used for rollback on checkout failure or task release
   */
  static async unassignIssue(
    repo: string,
    issueNumber: string,
    user: string
  ): Promise<void> {
    await this.configure();

    if (await isGhAvailable()) {
      const args = [
        'issue',
        'edit',
        issueNumber,
        '--repo',
        repo,
        '--remove-assignee',
        user,
      ];

      logger.debug(
        `[GH] gh issue edit ${issueNumber} --repo ${repo} --remove-assignee ${user}`
      );
      await execFileAsync('gh', args);
    } else {
      logger.debug(
        `[GH] REST API: unassign ${user} from issue #${issueNumber}`
      );
      await githubApi(
        'DELETE',
        `/repos/${repo}/issues/${issueNumber}/assignees`,
        { assignees: [user] }
      );
    }
    logger.debug(
      `[GH] Successfully unassigned ${user} from issue #${issueNumber}`
    );
  }

  /**
   * Update labels on an issue (add and/or remove)
   * Used for state machine transitions in heartbeat task queue
   */
  static async updateIssueLabels(
    repo: string,
    issueNumber: string,
    changes: { add?: string[]; remove?: string[] }
  ): Promise<void> {
    await this.configure();

    logger.debug(`[GH] Updating labels on issue #${issueNumber}:`, {
      add: changes.add,
      remove: changes.remove,
    });

    if (await isGhAvailable()) {
      const args = ['issue', 'edit', issueNumber, '--repo', repo];

      if (changes.add && changes.add.length > 0) {
        for (const label of changes.add) {
          args.push('--add-label', label);
        }
      }
      if (changes.remove && changes.remove.length > 0) {
        for (const label of changes.remove) {
          args.push('--remove-label', label);
        }
      }

      await execFileAsync('gh', args);
    } else {
      // REST API: get current labels, compute new set, replace
      const issue = (await githubApi(
        'GET',
        `/repos/${repo}/issues/${issueNumber}`
      )) as { labels?: { name: string }[] };
      const current = new Set(
        issue.labels?.map((l: { name: string }) => l.name) || []
      );
      if (changes.add) {
        for (const label of changes.add) current.add(label);
      }
      if (changes.remove) {
        for (const label of changes.remove) current.delete(label);
      }
      await githubApi('PATCH', `/repos/${repo}/issues/${issueNumber}`, {
        labels: [...current],
      });
    }
    logger.debug(`[GH] Successfully updated labels on issue #${issueNumber}`);
  }

  /**
   * Update an existing issue comment
   * Used for heartbeat timestamp updates (edit instead of creating new comments)
   */
  static async updateIssueComment(
    repo: string,
    commentId: number,
    body: string
  ): Promise<void> {
    await this.configure();

    logger.debug(`[GH] Updating comment ${commentId} on ${repo}`);
    if (await isGhAvailable()) {
      await execWithStdin(
        'gh',
        [
          'api',
          '--method',
          'PATCH',
          `/repos/${repo}/issues/comments/${commentId}`,
          '--input',
          '-',
        ],
        JSON.stringify({ body })
      );
    } else {
      await githubApi('PATCH', `/repos/${repo}/issues/comments/${commentId}`, {
        body,
      });
    }
    logger.debug(`[GH] Successfully updated comment ${commentId}`);
  }

  /**
   * Create an issue comment and return the comment data including ID
   * Used for creating initial heartbeat comment
   */
  static async createIssueComment(
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number; body: string }> {
    await this.configure();

    logger.debug(`[GH] Creating comment on issue #${issueNumber} in ${repo}`);
    let comment: { id: number; body: string };

    if (await isGhAvailable()) {
      const { stdout } = await execWithStdin(
        'gh',
        [
          'api',
          '--method',
          'POST',
          `/repos/${repo}/issues/${issueNumber}/comments`,
          '--input',
          '-',
        ],
        JSON.stringify({ body })
      );
      comment = JSON.parse(stdout);
    } else {
      comment = (await githubApi(
        'POST',
        `/repos/${repo}/issues/${issueNumber}/comments`,
        { body }
      )) as { id: number; body: string };
    }

    logger.debug(`[GH] Created comment ${comment.id} on issue #${issueNumber}`);
    return { id: comment.id, body: comment.body };
  }

  /**
   * Get current authenticated user
   * Used to identify which user to assign issues to
   */
  static async getCurrentUser(): Promise<string> {
    await this.configure();

    if (await isGhAvailable()) {
      const { stdout } = await execFileAsync('gh', [
        'api',
        'user',
        '--jq',
        '.login',
      ]);
      return stdout.trim();
    } else {
      const user = (await githubApi('GET', '/user')) as { login: string };
      return user.login;
    }
  }

  /**
   * Get issue assignees
   * Used to verify checkout success in optimistic concurrency
   */
  static async getIssueAssignees(
    repo: string,
    issueNumber: number
  ): Promise<string[]> {
    await this.configure();

    if (await isGhAvailable()) {
      const { stdout } = await execFileAsync('gh', [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'assignees',
      ]);
      const data = JSON.parse(stdout);
      return data.assignees?.map((a: { login: string }) => a.login) || [];
    } else {
      const issue = (await githubApi(
        'GET',
        `/repos/${repo}/issues/${issueNumber}`
      )) as { assignees?: { login: string }[] };
      return issue.assignees?.map((a) => a.login) || [];
    }
  }

  /**
   * Create a new issue
   * Used by create_task agent tool for task decomposition
   */
  static async createIssue(
    repo: string,
    options: {
      title: string;
      body: string;
      labels?: string[];
    }
  ): Promise<{ number: number; html_url: string }> {
    await this.configure();

    // Use --body-file - to pass body via stdin (handles long/complex bodies)
    const args = [
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      options.title,
      '--body-file',
      '-',
    ];

    if (options.labels && options.labels.length > 0) {
      for (const label of options.labels) {
        args.push('--label', label);
      }
    }

    logger.debug(`[GH] Creating issue in ${repo}`);
    logger.debug('[GH] Issue creation details', {
      title: options.title,
      labels: options.labels,
      bodyLength: options.body.length,
    });

    if (await isGhAvailable()) {
      const { stdout } = await execWithStdin('gh', args, options.body);

      // Parse URL to get issue number: https://github.com/owner/repo/issues/123
      const issueUrl = stdout.trim();
      const issueMatch = issueUrl.match(/\/issues\/(\d+)$/);
      if (!issueMatch) {
        throw new Error(`Could not parse issue number from URL: ${issueUrl}`);
      }
      const issueNumber = parseInt(issueMatch[1], 10);

      logger.info(
        `[GH] Successfully created issue #${issueNumber}: ${issueUrl}`
      );
      return { number: issueNumber, html_url: issueUrl };
    } else {
      const issue = (await githubApi('POST', `/repos/${repo}/issues`, {
        title: options.title,
        body: options.body,
        labels: options.labels || [],
      })) as { number: number; html_url: string };

      logger.info(
        `[GH] Successfully created issue #${issue.number}: ${issue.html_url}`
      );
      return { number: issue.number, html_url: issue.html_url };
    }
  }

  /**
   * List workflow runs for a branch+commit, filtered server-side.
   * Uses --commit for server-side SHA filtering.
   * Uses --event push to avoid pull_request merge-commit SHA mismatch.
   */
  /**
   * List workflow runs for a branch+commit, filtered server-side.
   * Falls back to REST API when gh CLI is not installed.
   */
  static async listWorkflowRuns(
    repo: string,
    branch: string,
    commitSha: string
  ): Promise<WorkflowRun[]> {
    if (await isGhAvailable()) {
      const { stdout } = await execFileAsync('gh', [
        'run',
        'list',
        '--repo',
        repo,
        '--branch',
        branch,
        '--commit',
        commitSha,
        '--event',
        'push',
        '--json',
        'databaseId,headSha,status,conclusion,workflowName,url,event',
        '--limit',
        '20',
      ]);
      return z.array(WorkflowRunSchema).parse(parseJsonArray(stdout));
    }

    // REST API fallback: /repos/{owner}/{repo}/actions/runs
    // Use head_sha for server-side commit filtering (same as gh --commit)
    const [owner, repoName] = repo.split('/');
    const params = new URLSearchParams({
      branch,
      head_sha: commitSha,
      event: 'push',
      per_page: '20',
    });
    const data = (await githubApi(
      'GET',
      `/repos/${owner}/${repoName}/actions/runs?${params}`
    )) as { workflow_runs?: Array<Record<string, unknown>> };
    const runs = (data.workflow_runs || []).map((r) => ({
      databaseId: r.id as number,
      headSha: r.head_sha as string,
      status: r.status as string,
      conclusion: (r.conclusion as string) || null,
      workflowName: r.name as string,
      url: r.html_url as string,
      event: r.event as string,
    }));
    return z.array(WorkflowRunSchema).parse(runs);
  }

  /**
   * Check whether a repo has any workflow files configured.
   * Falls back to REST API when gh CLI is not installed.
   */
  static async hasWorkflows(repo: string): Promise<boolean> {
    try {
      if (await isGhAvailable()) {
        const { stdout } = await execFileAsync('gh', [
          'workflow',
          'list',
          '--repo',
          repo,
          '--json',
          'name',
          '--limit',
          '1',
        ]);
        const data = parseJsonArray(stdout);
        return Array.isArray(data) && data.length > 0;
      }

      // REST API fallback
      const [owner, repoName] = repo.split('/');
      const data = (await githubApi(
        'GET',
        `/repos/${owner}/${repoName}/actions/workflows?per_page=1`
      )) as { total_count?: number };
      return (data.total_count ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Fetch failed job logs from a GitHub Actions run.
   * Returns truncated log output suitable for agent consumption, or null on error.
   * Falls back to REST API job annotations when gh CLI is not installed.
   */
  static async getRunFailedLogs(
    repo: string,
    runId: number
  ): Promise<string | null> {
    try {
      if (await isGhAvailable()) {
        const { stdout } = await execFileAsync('gh', [
          'run',
          'view',
          String(runId),
          '--repo',
          repo,
          '--log-failed',
        ]);
        return stdout.slice(0, 5000);
      }

      // REST API fallback: download per-job logs for failed jobs
      // GET /actions/jobs/{job_id}/logs returns plain text (302 → log content)
      const [owner, repoName] = repo.split('/');
      const data = (await githubApi(
        'GET',
        `/repos/${owner}/${repoName}/actions/runs/${runId}/jobs?filter=latest`
      )) as { jobs?: Array<Record<string, unknown>> };
      const jobs = data.jobs || [];
      const failedJobs = jobs.filter((j) => j.conclusion === 'failure');
      if (failedJobs.length === 0) return null;

      const lines: string[] = [];
      for (const job of failedJobs) {
        lines.push(`--- ${job.name} ---`);
        try {
          const logText = await githubApiText(
            `/repos/${owner}/${repoName}/actions/jobs/${job.id}/logs`
          );
          // Extract error-relevant lines from the full log
          const errorLines = logText
            .split('\n')
            .filter(
              (l) =>
                /error|ERROR|FOUND \d+|FAIL|fatal|exception|snapshot|update-snapshot/i.test(
                  l
                ) && l.trim().length > 0
            )
            .slice(0, 50);
          if (errorLines.length > 0) {
            lines.push(...errorLines);
          } else {
            // No error patterns found — include last 30 lines as context
            lines.push(...logText.split('\n').slice(-30));
          }
        } catch {
          // Log download failed — fall back to step names
          const steps = (job.steps as Array<Record<string, unknown>>) || [];
          const failedSteps = steps.filter((s) => s.conclusion === 'failure');
          for (const step of failedSteps) {
            lines.push(`Step "${step.name}": ${step.conclusion}`);
          }
        }
      }
      return lines.join('\n').slice(0, 5000) || null;
    } catch {
      return null;
    }
  }

  /**
   * Replace the body of an issue.
   * Uses gh api --method PATCH (gh CLI) or PATCH /repos/{owner}/{repo}/issues/{number} (REST API).
   */
  static async updateIssueBody(options: {
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<void> {
    await this.configure();

    logger.debug(
      `[GH] Updating body of issue #${options.issueNumber} in ${options.repo}`
    );

    if (await isGhAvailable()) {
      await execWithStdin(
        'gh',
        [
          'api',
          '--method',
          'PATCH',
          `/repos/${options.repo}/issues/${options.issueNumber}`,
          '--input',
          '-',
        ],
        JSON.stringify({ body: options.body })
      );
    } else {
      await githubApi(
        'PATCH',
        `/repos/${options.repo}/issues/${options.issueNumber}`,
        { body: options.body }
      );
    }
    logger.debug(
      `[GH] Successfully updated body of issue #${options.issueNumber}`
    );
  }
}

/**
 * Parse a JSON array from stdout, with fallback for output pollution
 * (e.g., library logs or warnings preceding the JSON payload).
 */
function parseJsonArray(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start !== -1 && end !== -1 && start < end) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(
      `Failed to parse JSON array from stdout: ${trimmed.slice(0, 200)}`
    );
  }
}
