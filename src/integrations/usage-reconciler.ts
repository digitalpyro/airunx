/**
 * Usage reconciler — compares the cost ledger's `billed` (API-key) spend per
 * closed UTC day against what the providers actually billed.
 *
 * Read-only: it never adjusts ledger figures. Provider sides:
 *   - Anthropic Admin API `GET /v1/organizations/cost_report` (daily buckets,
 *     amounts are decimal strings in cents)
 *   - OpenAI `GET /v1/organization/costs` (daily buckets, float dollars)
 *
 * Day assignment: a spawn belongs to the UTC day of its `started_at`
 * (fallback `ended_at`, then the event timestamp). A spawn whose start and
 * end fall on different UTC days is flagged as straddling midnight; its cost
 * stays on the start day but is added to the variance band of every window
 * day it touches, since the provider splits it across both.
 *
 * Security: admin keys are read only here (never by CLI children — see
 * `getFilteredEnv`), requests go only to fixed https hosts with redirects
 * refused and a timeout, and provider errors surface only as status codes or
 * our own messages, passed through `redactSecrets`. Response bodies are never
 * echoed.
 */

import chalk from 'chalk';
import { existsSync } from 'fs';
import { AuditLogger, getDefaultAuditDir } from '../audit/audit-logger.js';
import type { AuditEvent } from '../task-queue/types.js';
import { spawnEventCostSummary } from '../core/run-cost-summary.js';
import { redactSecrets } from '../utils/redaction.js';

/** Bumped when the JSON shape of ReconcileReport changes incompatibly */
export const RECONCILE_REPORT_VERSION = 1;

export type ReconcileProvider = 'anthropic' | 'openai';

export const RECONCILE_PROVIDERS: readonly ReconcileProvider[] = [
  'anthropic',
  'openai',
];

export type ReconcileStatus =
  | 'ok'
  | 'drift'
  | 'not-yet-final'
  | 'non-reconcilable'
  | 'non-attributable'
  | 'error';

/** Drift within this share of the provider total is "ok" */
export const DRIFT_TOLERANCE = 0.1;
/** Pagination stops (and the provider is reported as error) past this */
export const DEFAULT_PAGE_CAP = 20;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest window accepted by `--days` (Anthropic 1d buckets cap at 31) */
export const MAX_RECONCILE_DAYS = 31;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How long after a UTC day closes the provider's figures are final */
export const FINALITY_DELAY_MS: Record<ReconcileProvider, number> = {
  anthropic: HOUR_MS,
  openai: 24 * HOUR_MS,
};

/** Ledger backend → provider whose billing covers it */
const BACKEND_PROVIDER: Record<string, ReconcileProvider> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/** Fixed endpoints — never derived from configuration */
export const PROVIDER_ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1/organizations/cost_report',
  openai: 'https://api.openai.com/v1/organization/costs',
} as const;
const ALLOWED_HOSTS = new Set(['api.anthropic.com', 'api.openai.com']);
const ANTHROPIC_VERSION = '2023-06-01';

export const ADMIN_KEY_ENV: Record<ReconcileProvider, string> = {
  anthropic: 'ANTHROPIC_ADMIN_KEY',
  openai: 'OPENAI_ADMIN_KEY',
};
export const SCOPE_ENV: Record<ReconcileProvider, string> = {
  anthropic: 'AIRUNX_ANTHROPIC_WORKSPACE_ID',
  openai: 'AIRUNX_OPENAI_PROJECT_ID',
};

const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Scope value that selects Anthropic's default workspace (`workspace_id: null`). */
export const ANTHROPIC_DEFAULT_WORKSPACE = 'default';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ─── Money ──────────────────────────────────────────────────────────────

/**
 * Exact decimal string → integer micro-USD. `microPerUnitDigits` is log10 of
 * micro-USD per unit: 4 for cents, 6 for dollars. Rounds half away from zero
 * at the micro-USD digit. Returns undefined for anything that is not a plain
 * decimal (no exponents, no thousands separators).
 */
export function decimalToMicroUsd(
  value: string,
  microPerUnitDigits: number
): number | undefined {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return undefined;
  const [, sign, intPart = '', fracPart = ''] = match;
  if (intPart === '' && fracPart === '') return undefined;
  const kept = fracPart
    .slice(0, microPerUnitDigits)
    .padEnd(microPerUnitDigits, '0');
  let micro = BigInt(intPart || '0') * 10n ** BigInt(microPerUnitDigits);
  micro += BigInt(kept || '0');
  const next = fracPart.charAt(microPerUnitDigits);
  if (next !== '' && next >= '5') micro += 1n;
  const result = Number(micro);
  if (!Number.isSafeInteger(result)) return undefined;
  return sign === '-' && result !== 0 ? -result : result;
}

/** Anthropic cost_report amount (decimal string, cents) → micro-USD */
export function centsStringToMicroUsd(cents: string): number | undefined {
  return decimalToMicroUsd(cents, 4);
}

/** OpenAI costs amount (float dollars) → micro-USD */
export function dollarsToMicroUsd(dollars: unknown): number | undefined {
  if (typeof dollars === 'number') {
    return Number.isFinite(dollars) ? Math.round(dollars * 1e6) : undefined;
  }
  if (typeof dollars === 'string') return decimalToMicroUsd(dollars, 6);
  return undefined;
}

// ─── Window ─────────────────────────────────────────────────────────────

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Validate a YYYY-MM-DD calendar date */
export function isValidUtcDate(day: string): boolean {
  if (!DATE_PATTERN.test(day)) return false;
  const ms = dayStartMs(day);
  return Number.isFinite(ms) && utcDay(ms) === day;
}

/**
 * Days to reconcile, oldest first: `days` UTC days ending at `date`
 * (default yesterday). Throws on invalid input or future dates.
 */
export function resolveReconcileWindow(options: {
  date?: string;
  days?: number;
  now: Date;
}): string[] {
  const today = utcDay(options.now.getTime());
  const last = options.date ?? utcDay(dayStartMs(today) - DAY_MS);
  if (!isValidUtcDate(last)) {
    throw new Error(`Invalid --date "${last}"; expected YYYY-MM-DD`);
  }
  if (last > today) throw new Error(`--date ${last} is in the future`);
  const days = options.days ?? 1;
  if (!Number.isInteger(days) || days < 1 || days > MAX_RECONCILE_DAYS) {
    throw new Error(
      `Invalid --days ${String(options.days)}; expected 1-${MAX_RECONCILE_DAYS}`
    );
  }
  const end = dayStartMs(last);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(end - i * DAY_MS));
  return out;
}

/** True once the provider's figures for `day` are final */
export function isDayFinal(
  provider: ReconcileProvider,
  day: string,
  now: Date
): boolean {
  return (
    now.getTime() >= dayStartMs(day) + DAY_MS + FINALITY_DELAY_MS[provider]
  );
}

// ─── Ledger side ────────────────────────────────────────────────────────

export interface VarianceBand {
  /** Spend that may legitimately differ (each spawn counted once) */
  totalMicroUsd: number;
  /** Components (may overlap — a spawn can be estimated and straddling) */
  estimatedMicroUsd: number;
  unmodeledMicroUsd: number;
  straddleMicroUsd: number;
}

export interface LedgerDay {
  billedMicroUsd: number;
  billedSpawns: number;
  /** Billed spawns with no cost figure (unknown, not $0) */
  missingCostSpawns: number;
  /** Billed spawns starting or ending on this day that cross UTC midnight */
  straddlingSpawns: number;
  band: VarianceBand;
  /** Subscription (api_equivalent) or unknown-basis spawns — never reconciled */
  nonReconcilableSpawns: number;
  nonReconcilableMicroUsd: number;
}

export interface LedgerSummary {
  days: Map<string, LedgerDay>;
  /** Spawns on backends no provider feed covers (e.g. cursor) */
  otherBackendSpawns: number;
}

function emptyLedgerDay(): LedgerDay {
  return {
    billedMicroUsd: 0,
    billedSpawns: 0,
    missingCostSpawns: 0,
    straddlingSpawns: 0,
    band: {
      totalMicroUsd: 0,
      estimatedMicroUsd: 0,
      unmodeledMicroUsd: 0,
      straddleMicroUsd: 0,
    },
    nonReconcilableSpawns: 0,
    nonReconcilableMicroUsd: 0,
  };
}

function ledgerKey(provider: ReconcileProvider, day: string): string {
  return `${provider}|${day}`;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function spawnBasis(
  event: AuditEvent,
  summary: ReturnType<typeof spawnEventCostSummary>
): 'billed' | 'api_equivalent' | 'unknown' {
  if (summary.billedMicroUsd > 0) return 'billed';
  if (summary.apiEquivalentMicroUsd > 0) return 'api_equivalent';
  if (summary.unknownBasisMicroUsd > 0) return 'unknown';
  // Zero or missing cost: fall back to the recorded basis / auth mode
  const d = event.details ?? {};
  if (d.billing_basis === 'billed' || d.billing_basis === 'api_equivalent')
    return d.billing_basis;
  if (d.auth_mode === 'api_key') return 'billed';
  if (d.auth_mode === 'subscription') return 'api_equivalent';
  return 'unknown';
}

/**
 * Sum `llm_spawn` events per provider per UTC day for the window days.
 * Only `billed` spend enters the ledger total; other bases are counted as
 * non-reconcilable.
 */
export function summarizeLedger(
  events: readonly AuditEvent[],
  windowDays: readonly string[]
): LedgerSummary {
  const inWindow = new Set(windowDays);
  const days = new Map<string, LedgerDay>();
  let otherBackendSpawns = 0;
  const dayFor = (provider: ReconcileProvider, day: string): LedgerDay => {
    const key = ledgerKey(provider, day);
    let entry = days.get(key);
    if (!entry) {
      entry = emptyLedgerDay();
      days.set(key, entry);
    }
    return entry;
  };

  for (const event of events) {
    if (event.event !== 'llm_spawn') continue;
    const d = event.details ?? {};
    const startMs =
      parseTime(d.started_at) ??
      parseTime(d.ended_at) ??
      parseTime(event.timestamp);
    if (startMs === undefined) continue;
    const endMs = parseTime(d.ended_at) ?? startMs;
    const startDay = utcDay(startMs);
    const endDay = utcDay(Math.max(endMs, startMs));
    // Window days this spawn touches (start day through end day)
    const touched: string[] = [];
    for (
      let ms = dayStartMs(startDay);
      ms <= dayStartMs(endDay);
      ms += DAY_MS
    ) {
      const day = utcDay(ms);
      if (inWindow.has(day)) touched.push(day);
    }
    if (touched.length === 0) continue;

    const backend = typeof d.backend === 'string' ? d.backend : '';
    const provider = BACKEND_PROVIDER[backend];
    if (!provider) {
      if (inWindow.has(startDay)) otherBackendSpawns++;
      continue;
    }

    const summary = spawnEventCostSummary(event);
    const basis = spawnBasis(event, summary);
    if (basis !== 'billed') {
      if (inWindow.has(startDay)) {
        const entry = dayFor(provider, startDay);
        entry.nonReconcilableSpawns++;
        entry.nonReconcilableMicroUsd +=
          summary.apiEquivalentMicroUsd + summary.unknownBasisMicroUsd;
      }
      continue;
    }

    const micro = summary.billedMicroUsd;
    const straddles = startDay !== endDay;
    const estimated = summary.estimatedSpawns > 0;
    const unmodeled = summary.unmodeledModifiers.length > 0;

    if (inWindow.has(startDay)) {
      const entry = dayFor(provider, startDay);
      entry.billedSpawns++;
      entry.billedMicroUsd += micro;
      if (summary.missingCostSpawns > 0) entry.missingCostSpawns++;
      if (estimated) entry.band.estimatedMicroUsd += micro;
      if (unmodeled) entry.band.unmodeledMicroUsd += micro;
      if (estimated || unmodeled || straddles)
        entry.band.totalMicroUsd += micro;
    }
    if (straddles) {
      for (const day of touched) {
        const entry = dayFor(provider, day);
        entry.straddlingSpawns++;
        entry.band.straddleMicroUsd += micro;
        // Start-day band already includes this spawn above
        if (day !== startDay) entry.band.totalMicroUsd += micro;
      }
    }
  }
  return { days, otherBackendSpawns };
}

// ─── Provider side ──────────────────────────────────────────────────────

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

export interface ProviderCosts {
  /** UTC day → billed micro-USD */
  byDay: Map<string, number>;
  /** Sanitized failure reason; when set, byDay is incomplete */
  error?: string;
}

class ProviderRequestError extends Error {}

async function getJson(
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

interface Page {
  buckets: Array<{ day: string; results: unknown[] }>;
  hasMore: boolean;
  nextPage?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsePage(
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

async function fetchPaged(
  options: ProviderFetchOptions,
  buildUrl: (page?: string) => URL,
  headers: Record<string, string>,
  bucketDay: (b: Record<string, unknown>) => string | undefined,
  resultMicro: (r: Record<string, unknown>) => number | undefined
): Promise<ProviderCosts> {
  const byDay = new Map<string, number>();
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
        let total = byDay.get(bucket.day) ?? 0;
        for (const raw of bucket.results) {
          const result = asRecord(raw);
          const micro = result ? resultMicro(result) : undefined;
          if (micro === undefined) {
            throw new ProviderRequestError('unparsable cost amount');
          }
          total += micro;
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

function windowBounds(windowDays: readonly string[]): {
  startMs: number;
  endMs: number;
} {
  return {
    startMs: dayStartMs(windowDays[0]),
    endMs: dayStartMs(windowDays[windowDays.length - 1]) + DAY_MS,
  };
}

/**
 * Anthropic `cost_report`: `data[].starting_at` (RFC 3339) buckets with
 * `results[].amount` as a decimal string in cents and `currency` "USD";
 * grouped by workspace so a scope can be applied client-side.
 */
export function fetchAnthropicCosts(
  options: ProviderFetchOptions
): Promise<ProviderCosts> {
  const { startMs, endMs } = windowBounds(options.windowDays);
  const buildUrl = (page?: string): URL => {
    const url = new URL(PROVIDER_ENDPOINTS.anthropic);
    url.searchParams.set('starting_at', new Date(startMs).toISOString());
    url.searchParams.set('ending_at', new Date(endMs).toISOString());
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', String(options.windowDays.length));
    url.searchParams.append('group_by[]', 'workspace_id');
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
    (result) => {
      // The default workspace reports `workspace_id: null`.
      const workspaceId = result.workspace_id ?? ANTHROPIC_DEFAULT_WORKSPACE;
      if (options.scopeId !== undefined && workspaceId !== options.scopeId) {
        return 0;
      }
      if (
        typeof result.currency === 'string' &&
        result.currency.toUpperCase() !== 'USD'
      ) {
        return undefined;
      }
      return typeof result.amount === 'string'
        ? centsStringToMicroUsd(result.amount)
        : undefined;
    }
  );
}

/**
 * OpenAI `organization/costs`: `data[].start_time` (unix seconds) buckets
 * with `results[].amount.value` in dollars and `amount.currency` "usd";
 * filtered server-side by `project_ids` and re-checked per result.
 */
export function fetchOpenAiCosts(
  options: ProviderFetchOptions
): Promise<ProviderCosts> {
  const { startMs, endMs } = windowBounds(options.windowDays);
  const buildUrl = (page?: string): URL => {
    const url = new URL(PROVIDER_ENDPOINTS.openai);
    url.searchParams.set('start_time', String(Math.floor(startMs / 1000)));
    url.searchParams.set('end_time', String(Math.floor(endMs / 1000)));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', String(options.windowDays.length));
    // OpenAPI form-explode arrays: repeated keys without brackets.
    url.searchParams.append('group_by', 'project_id');
    if (options.scopeId !== undefined) {
      url.searchParams.append('project_ids', options.scopeId);
    }
    if (page) url.searchParams.set('page', page);
    return url;
  };
  return fetchPaged(
    options,
    buildUrl,
    { Authorization: `Bearer ${options.adminKey}` },
    (bucket) =>
      typeof bucket.start_time === 'number' &&
      Number.isFinite(bucket.start_time)
        ? utcDay(bucket.start_time * 1000)
        : undefined,
    (result) => {
      if (
        options.scopeId !== undefined &&
        result.project_id !== undefined &&
        result.project_id !== options.scopeId
      ) {
        return 0;
      }
      const amount = asRecord(result.amount);
      if (!amount) return undefined;
      if (
        typeof amount.currency === 'string' &&
        amount.currency.toLowerCase() !== 'usd'
      ) {
        return undefined;
      }
      return dollarsToMicroUsd(amount.value);
    }
  );
}

// ─── Reconciliation ─────────────────────────────────────────────────────

export interface ReconcileRow {
  provider: ReconcileProvider;
  date: string;
  status: ReconcileStatus;
  ledgerMicroUsd: number;
  /** null when the provider was not queried or failed */
  providerMicroUsd: number | null;
  /** ledger − provider */
  driftMicroUsd: number | null;
  /** drift as % of the provider total; null when provider total is 0/absent */
  driftPct: number | null;
  /** Within ±10% or within the variance band (null when not comparable) */
  withinTolerance: boolean | null;
  band: VarianceBand;
  billedSpawns: number;
  missingCostSpawns: number;
  straddlingSpawns: number;
  nonReconcilableSpawns: number;
  nonReconcilableMicroUsd: number;
  /** Workspace / project the provider total was restricted to */
  scope: string | null;
  final: boolean;
  notes: string[];
}

export interface ReconcileReport {
  version: number;
  generatedAt: string;
  days: string[];
  rows: ReconcileRow[];
  otherBackendSpawns: number;
  skippedLines: number;
  auditAvailable: boolean;
  warnings: string[];
}

export interface ReconcileOptions {
  date?: string;
  days?: number;
  anthropicWorkspace?: string;
  openaiProject?: string;
  /** Overrides for tests */
  now?: Date;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  auditDir?: string;
  timeoutMs?: number;
  pageCap?: number;
}

/** Billed-relevant ledger events for the window (plus a lookback margin) */
async function loadWindowEvents(
  windowDays: readonly string[],
  auditDir: string
): Promise<{ events: AuditEvent[]; skipped: number; available: boolean }> {
  // Check first: constructing an AuditLogger creates the directory
  if (!existsSync(auditDir))
    return { events: [], skipped: 0, available: false };
  const logger = new AuditLogger(auditDir);
  if (logger.listLogFiles().length === 0) {
    return { events: [], skipped: 0, available: false };
  }
  // Events are logged at spawn end; look back 2 days for long spawns
  const since = new Date(dayStartMs(windowDays[0]) - 2 * DAY_MS);
  const { events, skipped } = await logger.queryWithStats({
    eventTypes: ['llm_spawn'],
    since,
  });
  return { events, skipped, available: true };
}

function resolveScope(
  provider: ReconcileProvider,
  explicit: string | undefined,
  env: Record<string, string | undefined>
): string | undefined {
  const raw = explicit ?? env[SCOPE_ENV[provider]];
  const value = raw?.trim();
  if (!value) return undefined;
  if (!SCOPE_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${provider === 'anthropic' ? 'workspace' : 'project'} ID`
    );
  }
  return value;
}

function compare(
  ledger: number,
  provider: number,
  band: number
): Pick<ReconcileRow, 'driftMicroUsd' | 'driftPct' | 'withinTolerance'> {
  const drift = ledger - provider;
  const driftPct =
    provider !== 0 ? Math.round((drift / provider) * 10_000) / 100 : null;
  const withinPct =
    provider !== 0
      ? Math.abs(drift) <= Math.abs(provider) * DRIFT_TOLERANCE
      : drift === 0;
  return {
    driftMicroUsd: drift,
    driftPct,
    withinTolerance: withinPct || Math.abs(drift) <= band,
  };
}

/**
 * Reconcile ledger billed spend against provider cost reports for closed
 * UTC days. Never throws for provider failures or missing keys — those
 * become row statuses and warnings. Throws only on invalid options.
 */
export async function reconcileUsage(
  options: ReconcileOptions = {}
): Promise<ReconcileReport> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const windowDays = resolveReconcileWindow({
    date: options.date,
    days: options.days,
    now,
  });
  const scopes: Record<ReconcileProvider, string | undefined> = {
    anthropic: resolveScope('anthropic', options.anthropicWorkspace, env),
    openai: resolveScope('openai', options.openaiProject, env),
  };
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const { events, skipped, available } = await loadWindowEvents(
    windowDays,
    options.auditDir ?? getDefaultAuditDir()
  );
  const ledger = summarizeLedger(events, windowDays);
  const warnings: string[] = [];
  if (!available) warnings.push('No audit logs found; ledger totals are $0');

  const fetchers = {
    anthropic: fetchAnthropicCosts,
    openai: fetchOpenAiCosts,
  };
  const rows: ReconcileRow[] = [];

  for (const provider of RECONCILE_PROVIDERS) {
    const adminKey = env[ADMIN_KEY_ENV[provider]]?.trim();
    const scope = scopes[provider];
    let costs: ProviderCosts | undefined;
    if (!adminKey) {
      warnings.push(
        `${provider}: ${ADMIN_KEY_ENV[provider]} not set; billed spend is non-reconcilable`
      );
    } else {
      costs = await fetchers[provider]({
        adminKey,
        windowDays,
        scopeId: scope,
        fetchImpl,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pageCap: options.pageCap ?? DEFAULT_PAGE_CAP,
      });
      if (costs.error) {
        warnings.push(
          redactSecrets(`${provider}: cost report failed (${costs.error})`)
        );
      } else if (!scope) {
        warnings.push(
          `${provider}: no ${provider === 'anthropic' ? 'workspace' : 'project'} scope; provider totals are org-wide (non-attributable)`
        );
      }
    }

    for (const date of windowDays) {
      const day =
        ledger.days.get(ledgerKey(provider, date)) ?? emptyLedgerDay();
      const final = isDayFinal(provider, date, now);
      const notes: string[] = [];
      const providerMicro =
        costs && !costs.error ? (costs.byDay.get(date) ?? 0) : null;
      const comparison =
        providerMicro !== null
          ? compare(day.billedMicroUsd, providerMicro, day.band.totalMicroUsd)
          : { driftMicroUsd: null, driftPct: null, withinTolerance: null };

      let status: ReconcileStatus;
      if (!adminKey) {
        status = 'non-reconcilable';
        notes.push(`${ADMIN_KEY_ENV[provider]} not set`);
      } else if (costs?.error) {
        status = 'error';
        notes.push(costs.error);
      } else if (!final) {
        status = 'not-yet-final';
        notes.push('provider figures not yet final');
      } else if (!scope) {
        status = 'non-attributable';
        notes.push('org-wide provider total');
      } else {
        status = comparison.withinTolerance ? 'ok' : 'drift';
      }
      if (providerMicro !== null && !costs?.byDay.has(date)) {
        notes.push('provider returned no bucket for this day (counted as $0)');
      }
      if (day.missingCostSpawns > 0) {
        notes.push(
          `${day.missingCostSpawns} billed spawn(s) with unknown cost`
        );
      }
      if (day.straddlingSpawns > 0) {
        notes.push(`${day.straddlingSpawns} spawn(s) straddle UTC midnight`);
      }
      if (day.nonReconcilableSpawns > 0) {
        notes.push(
          `${day.nonReconcilableSpawns} subscription/unknown-basis spawn(s) non-reconcilable`
        );
      }

      rows.push({
        provider,
        date,
        status,
        ledgerMicroUsd: day.billedMicroUsd,
        providerMicroUsd: providerMicro,
        ...comparison,
        band: { ...day.band },
        billedSpawns: day.billedSpawns,
        missingCostSpawns: day.missingCostSpawns,
        straddlingSpawns: day.straddlingSpawns,
        nonReconcilableSpawns: day.nonReconcilableSpawns,
        nonReconcilableMicroUsd: day.nonReconcilableMicroUsd,
        scope: scope ?? null,
        final,
        notes: notes.map(redactSecrets),
      });
    }
  }

  if (ledger.otherBackendSpawns > 0) {
    warnings.push(
      `${ledger.otherBackendSpawns} spawn(s) on backends without a provider cost feed (e.g. cursor) not reconciled`
    );
  }

  return {
    version: RECONCILE_REPORT_VERSION,
    generatedAt: now.toISOString(),
    days: windowDays,
    rows,
    otherBackendSpawns: ledger.otherBackendSpawns,
    skippedLines: skipped,
    auditAvailable: available,
    warnings: warnings.map(redactSecrets),
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────

function usd(micro: number | null): string {
  if (micro === null) return '-';
  const sign = micro < 0 ? '-' : '';
  return `${sign}$${(Math.abs(micro) / 1_000_000).toFixed(4)}`;
}

function statusCell(status: ReconcileStatus): string {
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

/** Human-readable table for `airunx costs reconcile` */
export function formatReconcileReport(report: ReconcileReport): string {
  const headers = [
    'Provider',
    'Day',
    'Ledger',
    'Provider',
    'Drift',
    'Drift %',
    'Band',
    'Status',
  ];
  const rows = report.rows.map((r) => [
    r.provider,
    r.date,
    usd(r.ledgerMicroUsd),
    usd(r.providerMicroUsd),
    usd(r.driftMicroUsd),
    r.driftPct === null ? '-' : `${r.driftPct.toFixed(2)}%`,
    usd(r.band.totalMicroUsd),
    r.status,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );
  const line = (cells: string[], colorStatus = false): string =>
    '  ' +
    cells
      .map((c, i) => {
        const padded = i <= 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]);
        return colorStatus && i === cells.length - 1
          ? statusCell(c as ReconcileStatus) + ' '.repeat(widths[i] - c.length)
          : padded;
      })
      .join('  ');

  const out = [
    chalk.bold(
      `Cost reconciliation — ${report.days[0]}${report.days.length > 1 ? ` … ${report.days[report.days.length - 1]}` : ''} (UTC, billed spend only)`
    ),
    '',
    chalk.bold(line(headers)),
    `  ${'─'.repeat(widths.reduce((a, w) => a + w, 0) + 2 * (widths.length - 1))}`,
    ...rows.map((row) => line(row, true)),
  ];

  const noted = report.rows.filter((r) => r.notes.length > 0);
  if (noted.length > 0) {
    out.push('', chalk.bold('Notes'));
    for (const r of noted) {
      out.push(`  ${r.provider} ${r.date}: ${r.notes.join('; ')}`);
    }
  }
  if (report.skippedLines > 0) {
    out.push(
      '',
      chalk.yellow(`  ${report.skippedLines} unreadable ledger line(s) skipped`)
    );
  }
  out.push(
    '',
    chalk.dim(
      `  ok = within ±${DRIFT_TOLERANCE * 100}% or within the variance band (estimated + unmodeled + midnight-straddling spend)`
    )
  );
  return out.join('\n');
}
