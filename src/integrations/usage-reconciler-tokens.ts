/**
 * Anthropic token cross-check: ledger token counts per class (uncached
 * input, cache read, cache write, output) against the Admin API
 * `GET /v1/organizations/usage_report/messages`, with the same key, scope,
 * finality and fail-closed rules as the cost report.
 */

import chalk from 'chalk';
import type { AuditEvent } from '../task-queue/types.js';
import { spawnEventTokens } from '../core/run-cost-summary.js';
import { redactSecrets } from '../utils/redaction.js';
import {
  ADMIN_KEY_ENV,
  ANTHROPIC_DEFAULT_WORKSPACE,
  compare,
  fetchAnthropicDaily,
  inAnthropicScope,
  renderTable,
  asRecord,
  type ProviderDaily,
  type ProviderFetchOptions,
  type ReconcileStatus,
} from './usage-reconciler-shared.js';

/** Anthropic token usage feed for the token cross-check */
/** Anthropic token usage feed for the token cross-check */
export const ANTHROPIC_USAGE_ENDPOINT =
  'https://api.anthropic.com/v1/organizations/usage_report/messages';

/**
 * Token classes compared by the cross-check. `uncachedInput` excludes cache
 * reads and writes; `cacheWrite` sums the 5m and 1h cache-creation tiers
 * (the ledger's tier split is partial, so only the total is compared).
 */
export const TOKEN_CLASSES = [
  'uncachedInput',
  'cacheRead',
  'cacheWrite',
  'output',
] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];
export type TokenCounts = Record<TokenClass, number>;

export function emptyTokenCounts(): TokenCounts {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/** UTC day → tokens by class */
export type ProviderTokens = ProviderDaily<TokenCounts>;

/** Ledger-day fields the token cross-check reads */
export interface LedgerTokenDay {
  /** Billed-spawn tokens on their start day, by class */
  tokens: TokenCounts;
  /** Tokens that may legitimately differ: estimated-token and straddling spawns */
  tokenBand: TokenCounts;
  /** Billed spawns with no recorded token usage (unknown, not 0) */
  missingTokenSpawns: number;
  /** Billed spawns whose token counts were estimated */
  estimatedTokenSpawns: number;
}

/**
 * Ledger tokens by reconcile class. Ledger `input_tokens` is inclusive of
 * cache reads and writes (OTel semantics), so uncached input is the
 * remainder. Undefined when the spawn recorded no usage.
 */
export function spawnTokenCounts(event: AuditEvent): TokenCounts | undefined {
  const usage = spawnEventTokens(event);
  if (!usage) return undefined;
  return {
    uncachedInput: Math.max(
      0,
      usage.inputTokens -
        usage.cacheReadInputTokens -
        usage.cacheWriteInputTokens
    ),
    cacheRead: usage.cacheReadInputTokens,
    cacheWrite: usage.cacheWriteInputTokens,
    output: usage.outputTokens,
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** A JSON null token field counts as 0; absent stays invalid (undefined) */
function nullAsZero(value: unknown): number | undefined {
  return value === null ? 0 : tokenCount(value);
}

/**
 * One `usage_report/messages` result → tokens by class. Uncached input,
 * cache read and output are required (cache read may be null = 0);
 * `cache_creation` must be an object or null (= 0) whose 5m / 1h tiers (absent or null = 0) are summed into the cache-write class.
 */
export function usageResultTokens(
  result: Record<string, unknown>
): TokenCounts | undefined {
  const uncachedInput = tokenCount(result.uncached_input_tokens);
  const cacheRead = nullAsZero(result.cache_read_input_tokens);
  const output = tokenCount(result.output_tokens);
  const creation =
    result.cache_creation === null ? {} : asRecord(result.cache_creation);
  if (
    uncachedInput === undefined ||
    cacheRead === undefined ||
    output === undefined ||
    !creation
  ) {
    return undefined;
  }
  const tier = (value: unknown): number | undefined =>
    value === undefined || value === null ? 0 : tokenCount(value);
  const w5m = tier(creation.ephemeral_5m_input_tokens);
  const w1h = tier(creation.ephemeral_1h_input_tokens);
  if (w5m === undefined || w1h === undefined) return undefined;
  return { uncachedInput, cacheRead, cacheWrite: w5m + w1h, output };
}

/**
 * Anthropic `usage_report/messages`: same buckets, paging and scope rules
 * as the cost report. A real workspace scope is also sent server-side as
 * `workspace_ids[]` (the default workspace has no ID to filter on).
 */
export function fetchAnthropicUsage(
  options: ProviderFetchOptions
): Promise<ProviderTokens> {
  const { scopeId } = options;
  return fetchAnthropicDaily(
    options,
    ANTHROPIC_USAGE_ENDPOINT,
    {
      zero: emptyTokenCounts,
      add: (total, result) => {
        if (!inAnthropicScope(result, scopeId)) return total;
        const tokens = usageResultTokens(result);
        return tokens ? addTokenCounts(total, tokens) : undefined;
      },
      invalidMessage: 'unparsable token count',
    },
    (url) => {
      if (scopeId !== undefined && scopeId !== ANTHROPIC_DEFAULT_WORKSPACE) {
        url.searchParams.append('workspace_ids[]', scopeId);
      }
    }
  );
}

export interface TokenClassComparison {
  ledger: number;
  /** null when the usage report was not queried or failed */
  provider: number | null;
  /** ledger − provider */
  drift: number | null;
  /** drift as % of the provider count; null when provider count is 0/absent */
  driftPct: number | null;
  /** Within ±10% or within the token variance band (null when not comparable) */
  withinTolerance: boolean | null;
  /** Tokens from estimated-token or midnight-straddling spawns */
  band: number;
}

/** Ledger vs Anthropic usage report token counts for one day */
export interface TokenReconcile {
  /** Same status rules as the dollar row; `drift` when any class drifts */
  status: ReconcileStatus;
  classes: Record<TokenClass, TokenClassComparison>;
  /** Classes outside tolerance (only when status is ok/drift) */
  driftClasses: TokenClass[];
  missingTokenSpawns: number;
  estimatedTokenSpawns: number;
  notes: string[];
}

export function tokenReconcile(args: {
  day: LedgerTokenDay;
  date: string;
  adminKey: string | undefined;
  usage: ProviderTokens | undefined;
  final: boolean;
  scope: string | undefined;
}): TokenReconcile {
  const { day, date, adminKey, usage, final, scope } = args;
  const providerTokens =
    usage && !usage.error
      ? (usage.byDay.get(date) ?? emptyTokenCounts())
      : undefined;
  const classes = {} as Record<TokenClass, TokenClassComparison>;
  for (const cls of TOKEN_CLASSES) {
    const ledger = day.tokens[cls];
    const band = day.tokenBand[cls];
    if (providerTokens === undefined) {
      classes[cls] = {
        ledger,
        provider: null,
        drift: null,
        driftPct: null,
        withinTolerance: null,
        band,
      };
      continue;
    }
    const provider = providerTokens[cls];
    const c = compare(ledger, provider, band);
    classes[cls] = {
      ledger,
      provider,
      drift: c.drift,
      driftPct: c.driftPct,
      withinTolerance: c.withinTolerance,
      band,
    };
  }

  const notes: string[] = [];
  let status: ReconcileStatus;
  let driftClasses: TokenClass[] = [];
  if (!adminKey) {
    status = 'non-reconcilable';
    notes.push(`${ADMIN_KEY_ENV.anthropic} not set`);
  } else if (usage?.error) {
    status = 'error';
    notes.push(usage.error);
  } else if (!final) {
    status = 'not-yet-final';
    notes.push('provider figures not yet final');
  } else if (!scope) {
    status = 'non-attributable';
    notes.push('org-wide provider usage');
  } else {
    driftClasses = TOKEN_CLASSES.filter(
      (cls) => classes[cls].withinTolerance === false
    );
    status = driftClasses.length > 0 ? 'drift' : 'ok';
  }
  if (providerTokens !== undefined && !usage?.byDay.has(date)) {
    notes.push('usage report returned no bucket for this day (counted as 0)');
  }
  if (day.missingTokenSpawns > 0) {
    notes.push(
      `${day.missingTokenSpawns} billed spawn(s) with no recorded tokens`
    );
  }
  if (day.estimatedTokenSpawns > 0) {
    notes.push(
      `${day.estimatedTokenSpawns} billed spawn(s) with estimated tokens`
    );
  }
  return {
    status,
    classes,
    driftClasses,
    missingTokenSpawns: day.missingTokenSpawns,
    estimatedTokenSpawns: day.estimatedTokenSpawns,
    notes: notes.map(redactSecrets),
  };
}

const TOKEN_CLASS_LABELS: Record<TokenClass, string> = {
  uncachedInput: 'input (uncached)',
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
  output: 'output',
};

function count(value: number | null, signed = false): string {
  if (value === null) return '-';
  const text = Math.abs(value).toLocaleString('en-US');
  if (value < 0) return `-${text}`;
  return signed && value > 0 ? `+${text}` : text;
}

export function formatTokenSection(report: {
  rows: ReadonlyArray<{
    provider: string;
    date: string;
    tokens: TokenReconcile | null;
  }>;
}): string[] {
  const tokenRows = report.rows.filter(
    (r): r is typeof r & { tokens: TokenReconcile } => r.tokens !== null
  );
  if (tokenRows.length === 0) return [];
  const rows: string[][] = [];
  for (const r of tokenRows) {
    const comparable = r.tokens.status === 'ok' || r.tokens.status === 'drift';
    for (const cls of TOKEN_CLASSES) {
      const c = r.tokens.classes[cls];
      rows.push([
        r.date,
        TOKEN_CLASS_LABELS[cls],
        count(c.ledger),
        count(c.provider),
        count(c.drift, true),
        c.driftPct === null ? '-' : `${c.driftPct.toFixed(2)}%`,
        count(c.band),
        comparable ? (c.withinTolerance ? 'ok' : 'drift') : r.tokens.status,
      ]);
    }
  }
  const out = [
    '',
    chalk.bold(
      'Anthropic token cross-check (usage report, billed spawns only)'
    ),
    '',
    ...renderTable(
      [
        'Day',
        'Class',
        'Ledger',
        'Provider',
        'Drift',
        'Drift %',
        'Band',
        'Status',
      ],
      rows,
      2
    ),
  ];
  const noted = tokenRows.filter((r) => r.tokens.notes.length > 0);
  if (noted.length > 0) {
    out.push('', chalk.bold('Token notes'));
    for (const r of noted) {
      out.push(`  ${r.provider} ${r.date}: ${r.tokens.notes.join('; ')}`);
    }
  }
  return out;
}
