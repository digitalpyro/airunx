/**
 * Shared plumbing for the usage reconciler and its token cross-check:
 * provider fetch/paging/scope helpers, UTC day helpers, drift comparison and
 * table rendering. Imported by both modules so neither imports the other.
 */

import chalk from 'chalk';
import { redactSecrets } from '../utils/redaction.js';

export type ReconcileProvider = 'anthropic' | 'openai';

export type ReconcileStatus =
  | 'ok'
  | 'drift'
  | 'not-yet-final'
  | 'non-reconcilable'
  | 'non-attributable'
  | 'error';

/** Drift within this share of the provider total is "ok" */
export const DRIFT_TOLERANCE = 0.1;

export const DAY_MS = 86_400_000;

const ALLOWED_HOSTS = new Set(['api.anthropic.com', 'api.openai.com']);
const ANTHROPIC_VERSION = '2023-06-01';

export const ADMIN_KEY_ENV: Record<ReconcileProvider, string> = {
  anthropic: 'ANTHROPIC_ADMIN_KEY',
  openai: 'OPENAI_ADMIN_KEY',
};

/** Scope value that selects Anthropic's default workspace (`workspace_id: null`). */
export const ANTHROPIC_DEFAULT_WORKSPACE = 'default';

export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export type FetchLike = (
  input: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    redirect: 'error';
    signal: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body?: { cancel(): Promise<void> } | null;
}>;

export interface ProviderFetchOptions {
  adminKey: string;
  windowDays: readonly string[];
  /** Workspace (Anthropic) / project (OpenAI) to restrict to */
  scopeId?: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  pageCap: number;
}

/** Per-day provider figures from a paged daily-bucket report */
export interface ProviderDaily<T> {
  byDay: Map<string, T>;
  /** Sanitized failure reason; when set, byDay is incomplete */
  error?: string;
}

export class ProviderRequestError extends Error {}

export async function getJson(
  url: URL,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<unknown> {
  // Defense in depth: only the fixed provider hosts, only https
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new ProviderRequestError('refused non-provider URL');
  }
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    throw new ProviderRequestError(
      name === 'TimeoutError' || name === 'AbortError'
        ? 'request timed out'
        : 'request failed'
    );
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Body already consumed or unsupported — nothing to release
    }
    throw new ProviderRequestError(`HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderRequestError('invalid JSON response');
  }
}

export interface Page {
  buckets: Array<{ day: string; results: unknown[] }>;
  hasMore: boolean;
  nextPage?: string;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parsePage(
  body: unknown,
  bucketDay: (b: Record<string, unknown>) => string | undefined
): Page {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.data)) {
    throw new ProviderRequestError('unexpected response shape');
  }
  const buckets: Page['buckets'] = [];
  for (const raw of root.data) {
    const bucket = asRecord(raw);
    const day = bucket ? bucketDay(bucket) : undefined;
    if (!bucket || !day || !Array.isArray(bucket.results)) {
      throw new ProviderRequestError('unexpected response shape');
    }
    buckets.push({ day, results: bucket.results });
  }
  const nextPage =
    typeof root.next_page === 'string' && root.next_page.length > 0
      ? root.next_page
      : undefined;
  return { buckets, hasMore: root.has_more === true, nextPage };
}

/** How one result row folds into a day's running total */
export interface Accumulator<T> {
  zero: () => T;
  /** Undefined when the result is unparsable (fails the whole fetch) */
  add: (total: T, result: Record<string, unknown>) => T | undefined;
  invalidMessage: string;
}

export async function fetchPaged<T>(
  options: ProviderFetchOptions,
  buildUrl: (page?: string) => URL,
  headers: Record<string, string>,
  bucketDay: (b: Record<string, unknown>) => string | undefined,
  accumulator: Accumulator<T>
): Promise<ProviderDaily<T>> {
  const byDay = new Map<string, T>();
  const inWindow = new Set(options.windowDays);
  let page: string | undefined;
  try {
    for (let n = 0; ; n++) {
      if (n >= options.pageCap) {
        throw new ProviderRequestError(
          `page cap (${options.pageCap}) reached; totals incomplete`
        );
      }
      const body = await getJson(
        buildUrl(page),
        headers,
        options.fetchImpl,
        options.timeoutMs
      );
      const parsed = parsePage(body, bucketDay);
      for (const bucket of parsed.buckets) {
        if (!inWindow.has(bucket.day)) continue;
        let total = byDay.get(bucket.day) ?? accumulator.zero();
        for (const raw of bucket.results) {
          const result = asRecord(raw);
          const next = result ? accumulator.add(total, result) : undefined;
          if (next === undefined) {
            throw new ProviderRequestError(accumulator.invalidMessage);
          }
          total = next;
        }
        byDay.set(bucket.day, total);
      }
      if (!parsed.hasMore) break;
      if (!parsed.nextPage) {
        throw new ProviderRequestError('has_more without next_page');
      }
      page = parsed.nextPage;
    }
  } catch (error) {
    const message =
      error instanceof ProviderRequestError ? error.message : 'request failed';
    return { byDay, error: redactSecrets(message) };
  }
  return { byDay };
}

export function windowBounds(windowDays: readonly string[]): {
  startMs: number;
  endMs: number;
} {
  return {
    startMs: dayStartMs(windowDays[0]),
    endMs: dayStartMs(windowDays[windowDays.length - 1]) + DAY_MS,
  };
}

/**
 * Anthropic Admin API daily report (cost_report / usage_report): 1d buckets
 * over the window, grouped by workspace so the scope is always re-checked
 * client-side. `extraParams` adds endpoint-specific query parameters.
 */
export function fetchAnthropicDaily<T>(
  options: ProviderFetchOptions,
  endpoint: string,
  accumulator: Accumulator<T>,
  extraParams?: (url: URL) => void
): Promise<ProviderDaily<T>> {
  const { startMs, endMs } = windowBounds(options.windowDays);
  const buildUrl = (page?: string): URL => {
    const url = new URL(endpoint);
    url.searchParams.set('starting_at', new Date(startMs).toISOString());
    url.searchParams.set('ending_at', new Date(endMs).toISOString());
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', String(options.windowDays.length));
    url.searchParams.append('group_by[]', 'workspace_id');
    extraParams?.(url);
    if (page) url.searchParams.set('page', page);
    return url;
  };
  return fetchPaged(
    options,
    buildUrl,
    {
      'x-api-key': options.adminKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    (bucket) => {
      const ms = parseTime(bucket.starting_at);
      return ms === undefined ? undefined : utcDay(ms);
    },
    accumulator
  );
}

/**
 * Whether an Anthropic result belongs to the scope. The default workspace
 * reports `workspace_id: null`. A scoped fetch fails closed on a result with
 * no `workspace_id` key at all: it was not grouped by workspace, so it may be
 * org-wide and cannot be attributed.
 */
export function inAnthropicScope(
  result: Record<string, unknown>,
  scopeId: string | undefined
): boolean {
  if (scopeId === undefined) return true;
  if (!('workspace_id' in result)) {
    throw new ProviderRequestError('result not grouped by workspace');
  }
  const workspaceId = result.workspace_id ?? ANTHROPIC_DEFAULT_WORKSPACE;
  return workspaceId === scopeId;
}

/** Drift of ledger vs provider with the shared tolerance/band rule */
export interface Comparison {
  drift: number;
  driftPct: number | null;
  withinTolerance: boolean;
}

export function compare(
  ledger: number,
  provider: number,
  band: number
): Comparison {
  const drift = ledger - provider;
  const driftPct =
    provider !== 0 ? Math.round((drift / provider) * 10_000) / 100 : null;
  const withinPct =
    provider !== 0
      ? Math.abs(drift) <= Math.abs(provider) * DRIFT_TOLERANCE
      : drift === 0;
  return {
    drift,
    driftPct,
    withinTolerance: withinPct || Math.abs(drift) <= band,
  };
}

export function statusCell(status: ReconcileStatus): string {
  switch (status) {
    case 'ok':
      return chalk.green(status);
    case 'drift':
    case 'error':
      return chalk.red(status);
    default:
      return chalk.yellow(status);
  }
}

/** First `leftCols` columns left-aligned, the rest right; status colored */
export function renderTable(
  headers: string[],
  rows: string[][],
  leftCols: number
): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );
  const line = (cells: string[], colorStatus = false): string =>
    '  ' +
    cells
      .map((c, i) => {
        const padded =
          i < leftCols ? c.padEnd(widths[i]) : c.padStart(widths[i]);
        return colorStatus && i === cells.length - 1
          ? statusCell(c as ReconcileStatus) + ' '.repeat(widths[i] - c.length)
          : padded;
      })
      .join('  ');
  return [
    chalk.bold(line(headers)),
    `  ${'─'.repeat(widths.reduce((a, w) => a + w, 0) + 2 * (widths.length - 1))}`,
    ...rows.map((row) => line(row, true)),
  ];
}
