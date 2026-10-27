/**
 * usage-reconciler tests — fixture ledger + mocked provider cost reports.
 * No live network: every request goes through an injected fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  centsStringToMicroUsd,
  dollarsToMicroUsd,
  formatReconcileReport,
  isDayFinal,
  reconcileUsage,
  resolveReconcileWindow,
  summarizeLedger,
  type FetchLike,
  type ReconcileReport,
  type ReconcileRow,
  ANTHROPIC_DEFAULT_WORKSPACE,
  usageResultTokens,
} from '../../src/integrations/usage-reconciler.js';
import { reconcileCommand } from '../../src/cli/commands/costs.js';
import type { AuditEvent } from '../../src/task-queue/types.js';

const NOW = new Date('2026-10-16T12:00:00Z');
const ANTHROPIC_KEY = 'sk-ant-admin01-SECRETSECRETSECRETSECRET';
const OPENAI_KEY = 'sk-admin-SECRETSECRETSECRETSECRETSECRET';
const ENV = {
  ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY,
  OPENAI_ADMIN_KEY: OPENAI_KEY,
};

let tmpDir: string;
let auditDir: string;
let seq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
  auditDir = join(tmpDir, 'audit');
  seq = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface SpawnOpts {
  backend?: string;
  micro?: number;
  basis?: 'billed' | 'api_equivalent' | 'unknown';
  provenance?: 'reported' | 'derived' | 'estimated' | 'missing';
  start: string;
  end?: string;
  unmodeled?: string[];
  /** Ledger tokens (input inclusive of cache, as normalized) */
  usage?: { input: number; read?: number; write?: number; output?: number };
  tokenProvenance?: 'reported' | 'estimated';
}

function spawn(o: SpawnOpts): AuditEvent {
  seq++;
  return {
    timestamp: o.end ?? o.start,
    schema_version: 1,
    event_id: `01EVT${String(seq).padStart(8, '0')}`,
    workflowId: 'workflow-1700000000000-abcd1234',
    event: 'llm_spawn',
    details: {
      backend: o.backend ?? 'claude-code',
      auth_mode: o.basis === 'api_equivalent' ? 'subscription' : 'api_key',
      cost_micro_usd: o.micro,
      cost_usd: o.micro !== undefined ? o.micro / 1e6 : undefined,
      cost_provenance: o.provenance ?? 'reported',
      billing_basis: o.basis ?? 'billed',
      unmodeled_modifiers: o.unmodeled ?? [],
      started_at: o.start,
      ended_at: o.end ?? o.start,
      ...(o.usage
        ? {
            token_provenance: o.tokenProvenance ?? 'reported',
            usage: {
              input_tokens: o.usage.input,
              output_tokens: o.usage.output ?? 0,
              cache_read_input_tokens: o.usage.read ?? 0,
              cache_write_input_tokens: o.usage.write ?? 0,
            },
          }
        : {}),
    },
  } as AuditEvent;
}

function writeAudit(events: AuditEvent[]): void {
  mkdirSync(auditDir, { recursive: true });
  // Sorted by timestamp, as the logger would append them
  const sorted = [...events].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
  const byFile = new Map<string, string[]>();
  for (const e of sorted) {
    const file = `audit-${e.timestamp.slice(0, 10)}.jsonl`;
    byFile.set(file, [...(byFile.get(file) ?? []), JSON.stringify(e)]);
  }
  for (const [file, lines] of byFile) {
    writeFileSync(join(auditDir, file), lines.join('\n') + '\n');
  }
}

interface MockResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body: null;
}

function json(body: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: null,
  };
}

function anthropicPage(
  buckets: Array<{ day: string; amounts: Array<[string, string | null]> }>,
  nextPage?: string
): unknown {
  return {
    data: buckets.map((b) => ({
      starting_at: `${b.day}T00:00:00Z`,
      ending_at: `${b.day}T23:59:59Z`,
      results: b.amounts.map(([amount, ws]) => ({
        currency: 'USD',
        amount,
        workspace_id: ws,
      })),
    })),
    has_more: nextPage !== undefined,
    next_page: nextPage ?? null,
  };
}

function openaiPage(
  buckets: Array<{ day: string; values: number[] }>,
  nextPage?: string
): unknown {
  return {
    object: 'page',
    data: buckets.map((b) => ({
      object: 'bucket',
      start_time: Date.parse(`${b.day}T00:00:00Z`) / 1000,
      end_time: Date.parse(`${b.day}T00:00:00Z`) / 1000 + 86400,
      results: b.values.map((value) => ({
        object: 'organization.costs.result',
        amount: { value, currency: 'usd' },
        project_id: 'proj_airunx',
      })),
    })),
    has_more: nextPage !== undefined,
    next_page: nextPage ?? null,
  };
}

type UsageResult = {
  uncached?: number;
  read?: number;
  w5m?: number;
  w1h?: number;
  output?: number;
  ws?: string | null;
};

function usagePage(
  buckets: Array<{ day: string; results: UsageResult[] }>,
  nextPage?: string
): unknown {
  return {
    data: buckets.map((b) => ({
      starting_at: `${b.day}T00:00:00Z`,
      ending_at: `${b.day}T23:59:59Z`,
      results: b.results.map((r) => ({
        uncached_input_tokens: r.uncached ?? 0,
        cache_read_input_tokens: r.read ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: r.w5m ?? 0,
          ephemeral_1h_input_tokens: r.w1h ?? 0,
        },
        output_tokens: r.output ?? 0,
        server_tool_use: { web_search_requests: 0 },
        workspace_id: r.ws === undefined ? 'w1' : r.ws,
      })),
    })),
    has_more: nextPage !== undefined,
    next_page: nextPage ?? null,
  };
}

const USAGE_PATH = '/v1/organizations/usage_report/messages';

/**
 * Routes by host; each handler gets the parsed URL. Anthropic usage-report
 * requests go to `anthropicUsage` (default: an empty page).
 */
function mockFetch(handlers: {
  anthropic?: (url: URL) => MockResponse | Promise<MockResponse>;
  anthropicUsage?: (url: URL) => MockResponse | Promise<MockResponse>;
  openai?: (url: URL) => MockResponse | Promise<MockResponse>;
}) {
  const fn = vi.fn(async (input: string, init: Parameters<FetchLike>[1]) => {
    const url = new URL(input);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const handler =
      url.hostname === 'api.anthropic.com'
        ? url.pathname === USAGE_PATH
          ? (handlers.anthropicUsage ?? (() => json(usagePage([]))))
          : handlers.anthropic
        : url.hostname === 'api.openai.com'
          ? handlers.openai
          : undefined;
    if (!handler) throw new Error(`unexpected host ${url.hostname}`);
    return handler(url);
  });
  return fn;
}

function row(
  report: ReconcileReport,
  provider: string,
  date: string
): ReconcileRow {
  const found = report.rows.find(
    (r) => r.provider === provider && r.date === date
  );
  if (!found) throw new Error(`no row ${provider} ${date}`);
  return found;
}

describe('money conversion', () => {
  it('converts decimal-string cents to micro-USD without float error', () => {
    // 123.456789 cents = $1.23456789 → 1,234,568 micro-USD (rounded)
    expect(centsStringToMicroUsd('123.456789')).toBe(1_234_568);
    expect(centsStringToMicroUsd('0.1')).toBe(1_000);
    expect(centsStringToMicroUsd('0.00004')).toBe(0);
    expect(centsStringToMicroUsd('0.00005')).toBe(1);
    expect(centsStringToMicroUsd('100')).toBe(1_000_000);
    expect(centsStringToMicroUsd('-25.5')).toBe(-255_000);
    // Summing many small strings stays exact
    let total = 0;
    for (let i = 0; i < 10; i++) total += centsStringToMicroUsd('0.1')!;
    expect(total).toBe(10_000);
  });

  it('rejects non-decimal amounts', () => {
    expect(centsStringToMicroUsd('1e3')).toBeUndefined();
    expect(centsStringToMicroUsd('abc')).toBeUndefined();
    expect(centsStringToMicroUsd('')).toBeUndefined();
    expect(centsStringToMicroUsd('1,000')).toBeUndefined();
  });

  it('converts float dollars to micro-USD', () => {
    expect(dollarsToMicroUsd(0.06)).toBe(60_000);
    expect(dollarsToMicroUsd(12.345678)).toBe(12_345_678);
    expect(dollarsToMicroUsd('0.1')).toBe(100_000);
    expect(dollarsToMicroUsd(Number.NaN)).toBeUndefined();
    expect(dollarsToMicroUsd(null)).toBeUndefined();
  });
});

describe('window and finality', () => {
  it('defaults to yesterday and supports --days', () => {
    expect(resolveReconcileWindow({ now: NOW })).toEqual(['2026-10-15']);
    expect(
      resolveReconcileWindow({ date: '2026-10-02', days: 3, now: NOW })
    ).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('rejects invalid and future dates', () => {
    expect(() =>
      resolveReconcileWindow({ date: '2026-02-30', now: NOW })
    ).toThrow(/Invalid --date/);
    expect(() =>
      resolveReconcileWindow({ date: '2026-10-17', now: NOW })
    ).toThrow(/future/);
    expect(() => resolveReconcileWindow({ days: 0, now: NOW })).toThrow(
      /--days/
    );
    expect(() => resolveReconcileWindow({ days: 32, now: NOW })).toThrow(
      /--days/
    );
  });

  it('applies provider finality delays', () => {
    const justClosed = new Date('2026-10-16T00:30:00Z');
    expect(isDayFinal('anthropic', '2026-10-15', justClosed)).toBe(false);
    expect(isDayFinal('anthropic', '2026-10-15', NOW)).toBe(true);
    expect(isDayFinal('openai', '2026-10-15', NOW)).toBe(false);
    expect(isDayFinal('openai', '2026-10-14', NOW)).toBe(true);
    expect(isDayFinal('anthropic', '2026-10-16', NOW)).toBe(false);
  });
});

describe('summarizeLedger', () => {
  const DAY = '2026-10-14';

  it('sums billed spend per provider and day, excluding other days', () => {
    const ledger = summarizeLedger(
      [
        spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` }),
        spawn({ micro: 500_000, start: `${DAY}T23:00:00Z` }),
        spawn({ backend: 'codex', micro: 200_000, start: `${DAY}T05:00:00Z` }),
        // Outside the window
        spawn({ micro: 9_000_000, start: '2026-10-13T12:00:00Z' }),
        spawn({ micro: 9_000_000, start: '2026-10-15T00:00:00Z' }),
      ],
      [DAY]
    );
    expect(ledger.days.get(`anthropic|${DAY}`)?.billedMicroUsd).toBe(1_500_000);
    expect(ledger.days.get(`anthropic|${DAY}`)?.billedSpawns).toBe(2);
    expect(ledger.days.get(`openai|${DAY}`)?.billedMicroUsd).toBe(200_000);
  });

  it('counts subscription and unknown-basis spawns as non-reconcilable', () => {
    const ledger = summarizeLedger(
      [
        spawn({
          micro: 3_000_000,
          basis: 'api_equivalent',
          start: `${DAY}T10:00:00Z`,
        }),
        spawn({ micro: 100, basis: 'unknown', start: `${DAY}T11:00:00Z` }),
        spawn({ micro: 1_000_000, start: `${DAY}T12:00:00Z` }),
        spawn({ backend: 'cursor', micro: 5, start: `${DAY}T12:00:00Z` }),
      ],
      [DAY]
    );
    const day = ledger.days.get(`anthropic|${DAY}`)!;
    expect(day.billedMicroUsd).toBe(1_000_000);
    expect(day.nonReconcilableSpawns).toBe(2);
    expect(day.nonReconcilableMicroUsd).toBe(3_000_100);
    expect(ledger.otherBackendSpawns).toBe(1);
  });

  it('puts estimated and unmodeled spend in the band once per spawn', () => {
    const ledger = summarizeLedger(
      [
        spawn({
          micro: 400_000,
          provenance: 'estimated',
          unmodeled: ['batch'],
          start: `${DAY}T10:00:00Z`,
        }),
        spawn({
          micro: 100_000,
          unmodeled: ['priority_tier'],
          start: `${DAY}T11:00:00Z`,
        }),
        spawn({ micro: 2_000_000, start: `${DAY}T12:00:00Z` }),
      ],
      [DAY]
    );
    const band = ledger.days.get(`anthropic|${DAY}`)!.band;
    expect(band.estimatedMicroUsd).toBe(400_000);
    expect(band.unmodeledMicroUsd).toBe(500_000);
    expect(band.totalMicroUsd).toBe(500_000);
  });

  it('assigns a midnight-straddling spawn to its start day and bands both days', () => {
    const ledger = summarizeLedger(
      [
        spawn({
          micro: 700_000,
          start: '2026-10-13T23:50:00Z',
          end: '2026-10-14T00:20:00Z',
        }),
      ],
      ['2026-10-13', '2026-10-14']
    );
    const start = ledger.days.get('anthropic|2026-10-13')!;
    const end = ledger.days.get('anthropic|2026-10-14')!;
    expect(start.billedMicroUsd).toBe(700_000);
    expect(start.band.straddleMicroUsd).toBe(700_000);
    expect(start.band.totalMicroUsd).toBe(700_000);
    expect(start.straddlingSpawns).toBe(1);
    expect(end.billedMicroUsd).toBe(0);
    expect(end.band.straddleMicroUsd).toBe(700_000);
    expect(end.band.totalMicroUsd).toBe(700_000);
  });

  it('bands a straddler that started the day before the window', () => {
    const ledger = summarizeLedger(
      [
        spawn({
          micro: 300_000,
          start: '2026-10-13T23:50:00Z',
          end: '2026-10-14T00:20:00Z',
        }),
      ],
      [DAY]
    );
    const day = ledger.days.get(`anthropic|${DAY}`)!;
    expect(day.billedMicroUsd).toBe(0);
    expect(day.band.totalMicroUsd).toBe(300_000);
  });
});

describe('reconcileUsage', () => {
  const DAY = '2026-10-14';

  it('computes drift against both providers', async () => {
    writeAudit([
      spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` }),
      spawn({ backend: 'codex', micro: 2_000_000, start: `${DAY}T10:00:00Z` }),
      spawn({
        micro: 5_000_000,
        basis: 'api_equivalent',
        start: `${DAY}T10:00:00Z`,
      }),
    ]);
    const fetchImpl = mockFetch({
      anthropic: (url) => {
        expect(url.pathname).toBe('/v1/organizations/cost_report');
        expect(url.searchParams.get('starting_at')).toBe(
          '2026-10-14T00:00:00.000Z'
        );
        expect(url.searchParams.get('ending_at')).toBe(
          '2026-10-15T00:00:00.000Z'
        );
        expect(url.searchParams.get('bucket_width')).toBe('1d');
        expect(url.searchParams.getAll('group_by[]')).toEqual(['workspace_id']);
        // $1.05 for the AIRUNX workspace, foreign spend ignored
        return json(
          anthropicPage([
            {
              day: DAY,
              amounts: [
                ['100.5', 'wrkspc_airunx'],
                ['4.5', 'wrkspc_airunx'],
                ['999', 'wrkspc_other'],
              ],
            },
          ])
        );
      },
      openai: (url) => {
        expect(url.pathname).toBe('/v1/organization/costs');
        expect(url.searchParams.get('start_time')).toBe(
          String(Date.parse(`${DAY}T00:00:00Z`) / 1000)
        );
        expect(url.searchParams.getAll('project_ids')).toEqual(['proj_airunx']);
        return json(openaiPage([{ day: DAY, values: [1.5] }]));
      },
    });

    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: ENV,
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'wrkspc_airunx',
      openaiProject: 'proj_airunx',
    });

    const a = row(report, 'anthropic', DAY);
    expect(a.ledgerMicroUsd).toBe(1_000_000);
    expect(a.providerMicroUsd).toBe(1_050_000);
    expect(a.driftMicroUsd).toBe(-50_000);
    expect(a.driftPct).toBe(-4.76);
    expect(a.status).toBe('ok');
    expect(a.nonReconcilableSpawns).toBe(1);

    const o = row(report, 'openai', DAY);
    expect(o.ledgerMicroUsd).toBe(2_000_000);
    expect(o.providerMicroUsd).toBe(1_500_000);
    expect(o.driftMicroUsd).toBe(500_000);
    expect(o.driftPct).toBe(33.33);
    expect(o.status).toBe('drift');

    // Headers carry the admin keys; the report never does
    const [, anthropicInit] = fetchImpl.mock.calls.find(([u]) =>
      u.includes('anthropic')
    )!;
    expect(anthropicInit.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(anthropicInit.headers['anthropic-version']).toBe('2023-06-01');
    const [, openaiInit] = fetchImpl.mock.calls.find(([u]) =>
      u.includes('openai')
    )!;
    expect(openaiInit.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET');
    expect(formatReconcileReport(report)).toContain('drift');
  });

  it('treats drift explained by the variance band as ok', async () => {
    writeAudit([
      spawn({
        micro: 1_000_000,
        provenance: 'estimated',
        start: `${DAY}T10:00:00Z`,
      }),
    ]);
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: () =>
          json(anthropicPage([{ day: DAY, amounts: [['50', 'w1']] }])),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    const a = row(report, 'anthropic', DAY);
    expect(a.driftMicroUsd).toBe(500_000);
    expect(a.driftPct).toBe(100);
    expect(a.band.totalMicroUsd).toBe(1_000_000);
    expect(a.status).toBe('ok');
  });

  it('scopes to the default workspace (null workspace_id) via "default"', async () => {
    writeAudit([spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` })]);
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: () =>
          json(
            anthropicPage([
              {
                day: DAY,
                amounts: [
                  ['100', null],
                  ['999', 'wrkspc_other'],
                ],
              },
            ])
          ),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: ANTHROPIC_DEFAULT_WORKSPACE,
    });
    const a = row(report, 'anthropic', DAY);
    expect(a.providerMicroUsd).toBe(1_000_000);
    expect(a.status).toBe('ok');
  });

  it('flags a day the provider returned no bucket for', async () => {
    writeAudit([spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` })]);
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { OPENAI_ADMIN_KEY: OPENAI_KEY },
      fetchImpl: mockFetch({
        openai: (url) => {
          expect(url.searchParams.getAll('group_by')).toEqual(['project_id']);
          expect(url.searchParams.has('group_by[]')).toBe(false);
          return json(openaiPage([]));
        },
      }) as unknown as FetchLike,
      auditDir,
      openaiProject: 'proj_airunx',
    });
    const o = row(report, 'openai', DAY);
    expect(o.providerMicroUsd).toBe(0);
    expect(o.notes.join(' ')).toContain('no bucket');
  });

  it('sums every page and enforces the page cap', async () => {
    writeAudit([spawn({ micro: 3_000_000, start: `${DAY}T10:00:00Z` })]);
    const pages = [
      anthropicPage([{ day: DAY, amounts: [['100', 'w1']] }], 'p2'),
      anthropicPage([{ day: DAY, amounts: [['100', 'w1']] }], 'p3'),
      anthropicPage([{ day: DAY, amounts: [['100', 'w1']] }]),
    ];
    const seen: Array<string | null> = [];
    const fetchImpl = mockFetch({
      anthropic: (url) => {
        seen.push(url.searchParams.get('page'));
        return json(pages[seen.length - 1]);
      },
    });
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    expect(seen).toEqual([null, 'p2', 'p3']);
    expect(row(report, 'anthropic', DAY).providerMicroUsd).toBe(3_000_000);
    expect(row(report, 'anthropic', DAY).status).toBe('ok');

    // Endless pagination stops at the cap
    const endless = mockFetch({
      anthropic: () =>
        json(anthropicPage([{ day: DAY, amounts: [['1', 'w1']] }], 'more')),
    });
    const capped = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: endless as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
      pageCap: 5,
    });
    const costCalls = endless.mock.calls.filter(
      ([u]) => new URL(u).pathname !== USAGE_PATH
    );
    expect(costCalls).toHaveLength(5);
    const a = row(capped, 'anthropic', DAY);
    expect(a.status).toBe('error');
    expect(a.providerMicroUsd).toBeNull();
    expect(capped.warnings.join('\n')).toMatch(/page cap \(5\)/);
  });

  it('follows OpenAI pagination', async () => {
    const fetchImpl = mockFetch({
      openai: (url) =>
        url.searchParams.get('page') === 'next'
          ? json(openaiPage([{ day: DAY, values: [0.25] }]))
          : json(openaiPage([{ day: DAY, values: [0.1, 0.2] }], 'next')),
    });
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { OPENAI_ADMIN_KEY: OPENAI_KEY },
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
      openaiProject: 'proj_airunx',
    });
    expect(row(report, 'openai', DAY).providerMicroUsd).toBe(550_000);
  });

  it('reports today and just-closed days as not yet final', async () => {
    const fetchImpl = mockFetch({
      anthropic: () => json(anthropicPage([])),
      openai: () => json(openaiPage([])),
    });
    const report = await reconcileUsage({
      date: '2026-10-16',
      days: 2,
      now: NOW,
      env: ENV,
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
      openaiProject: 'p1',
    });
    expect(row(report, 'anthropic', '2026-10-16').status).toBe('not-yet-final');
    // Closed 12h ago: final for Anthropic (1h), not for OpenAI (24h)
    expect(row(report, 'anthropic', '2026-10-15').status).toBe('ok');
    expect(row(report, 'openai', '2026-10-15').status).toBe('not-yet-final');
    expect(row(report, 'openai', '2026-10-16').final).toBe(false);
  });

  it('fails closed to non-reconcilable when admin keys are missing', async () => {
    writeAudit([spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` })]);
    const fetchImpl = vi.fn();
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: {},
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const a = row(report, 'anthropic', DAY);
    expect(a.status).toBe('non-reconcilable');
    expect(a.ledgerMicroUsd).toBe(1_000_000);
    expect(a.providerMicroUsd).toBeNull();
    expect(row(report, 'openai', DAY).status).toBe('non-reconcilable');
    expect(report.warnings.join('\n')).toMatch(/ANTHROPIC_ADMIN_KEY not set/);
  });

  it('reports provider failures without raw payloads, keeping other providers', async () => {
    writeAudit([
      spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` }),
      spawn({ backend: 'codex', micro: 1_000_000, start: `${DAY}T10:00:00Z` }),
    ]);
    const leak = `{"error":"bad key ${ANTHROPIC_KEY}","detail":"RAW_BODY_MARKER"}`;
    const fetchImpl = mockFetch({
      anthropic: () => ({
        ok: false,
        status: 401,
        json: async () => JSON.parse(leak),
        body: null,
      }),
      openai: () => json(openaiPage([{ day: DAY, values: [1] }])),
    });
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: ENV,
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
      openaiProject: 'proj_airunx',
    });
    const a = row(report, 'anthropic', DAY);
    expect(a.status).toBe('error');
    expect(a.notes).toContain('HTTP 401');
    expect(a.ledgerMicroUsd).toBe(1_000_000);
    expect(row(report, 'openai', DAY).status).toBe('ok');
    const serialized = JSON.stringify(report) + formatReconcileReport(report);
    expect(serialized).not.toContain('RAW_BODY_MARKER');
    expect(serialized).not.toContain('SECRET');
  });

  it('never echoes thrown network error messages', async () => {
    const fetchImpl = mockFetch({
      anthropic: () => {
        throw new Error(`connect failed for key ${ANTHROPIC_KEY}`);
      },
    });
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
    });
    expect(row(report, 'anthropic', DAY).notes).toContain('request failed');
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('rejects malformed provider responses', async () => {
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { OPENAI_ADMIN_KEY: OPENAI_KEY },
      fetchImpl: mockFetch({
        openai: () => json({ unexpected: 'shape' }),
      }) as unknown as FetchLike,
      auditDir,
      openaiProject: 'p1',
    });
    const o = row(report, 'openai', DAY);
    expect(o.status).toBe('error');
    expect(o.notes).toContain('unexpected response shape');
  });

  it('reports unscoped org totals as non-attributable but shows numbers', async () => {
    writeAudit([spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` })]);
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: () =>
          json(
            anthropicPage([
              {
                day: DAY,
                amounts: [
                  ['100', 'w1'],
                  ['20', null],
                ],
              },
            ])
          ),
      }) as unknown as FetchLike,
      auditDir,
    });
    const a = row(report, 'anthropic', DAY);
    expect(a.status).toBe('non-attributable');
    expect(a.scope).toBeNull();
    expect(a.providerMicroUsd).toBe(1_200_000);
    expect(a.driftMicroUsd).toBe(-200_000);
    expect(report.warnings.join('\n')).toMatch(/non-attributable/);
  });

  it('fails closed when a scoped cost report result has no workspace_id', async () => {
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: () =>
          json({
            data: [
              {
                starting_at: `${DAY}T00:00:00Z`,
                results: [{ currency: 'USD', amount: '100' }],
              },
            ],
            has_more: false,
          }),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: ANTHROPIC_DEFAULT_WORKSPACE,
    });
    const a = row(report, 'anthropic', DAY);
    expect(a.status).toBe('error');
    expect(a.notes).toContain('result not grouped by workspace');
  });

  it('reads scopes from the environment and validates them', async () => {
    const fetchImpl = mockFetch({
      openai: (url) => {
        expect(url.searchParams.getAll('project_ids')).toEqual(['proj_env']);
        return json(openaiPage([]));
      },
    });
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: {
        OPENAI_ADMIN_KEY: OPENAI_KEY,
        AIRUNX_OPENAI_PROJECT_ID: 'proj_env',
      },
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
    });
    expect(row(report, 'openai', DAY).scope).toBe('proj_env');

    const anthropicFetch = mockFetch({
      anthropic: () =>
        json(
          anthropicPage([
            {
              day: DAY,
              amounts: [
                ['100', 'wrkspc_env'],
                ['999', 'wrkspc_other'],
              ],
            },
          ])
        ),
      anthropicUsage: (url) => {
        expect(url.searchParams.getAll('workspace_ids[]')).toEqual([
          'wrkspc_env',
        ]);
        return json(usagePage([]));
      },
    });
    const anthropicReport = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: {
        ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY,
        AIRUNX_ANTHROPIC_WORKSPACE_ID: 'wrkspc_env',
      },
      fetchImpl: anthropicFetch as unknown as FetchLike,
      auditDir,
    });
    const a = row(anthropicReport, 'anthropic', DAY);
    expect(a.scope).toBe('wrkspc_env');
    expect(a.providerMicroUsd).toBe(1_000_000);
    expect(a.status).toBe('drift');
    expect(anthropicReport.warnings.join('\n')).not.toMatch(/non-attributable/);
    // An explicit --anthropic-workspace wins over the environment
    const explicit = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: {
        ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY,
        AIRUNX_ANTHROPIC_WORKSPACE_ID: 'wrkspc_env',
      },
      fetchImpl: mockFetch({
        anthropic: () => json(anthropicPage([])),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'wrkspc_flag',
    });
    expect(row(explicit, 'anthropic', DAY).scope).toBe('wrkspc_flag');
    await expect(
      reconcileUsage({
        date: DAY,
        now: NOW,
        env: {},
        auditDir,
        anthropicWorkspace: 'bad id/../x',
      })
    ).rejects.toThrow(/Invalid workspace ID/);
  });

  it('does not create the audit directory and is read-only', async () => {
    const missing = join(tmpDir, 'nope');
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: {},
      auditDir: missing,
    });
    expect(report.auditAvailable).toBe(false);
    const { existsSync } = await import('fs');
    expect(existsSync(missing)).toBe(false);
  });
});

describe('usageResultTokens', () => {
  it('maps usage report fields and sums both cache-write tiers', () => {
    expect(
      usageResultTokens({
        uncached_input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 4,
        },
        output_tokens: 5,
      })
    ).toEqual({ uncachedInput: 10, cacheRead: 20, cacheWrite: 7, output: 5 });
    // A missing tier is 0; a missing class or non-integer fails
    expect(
      usageResultTokens({
        uncached_input_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 2 },
        output_tokens: 0,
      })?.cacheWrite
    ).toBe(2);
    expect(
      usageResultTokens({
        uncached_input_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      })
    ).toBeUndefined();
    expect(
      usageResultTokens({
        uncached_input_tokens: '1',
        cache_read_input_tokens: 0,
        cache_creation: {},
        output_tokens: 0,
      })
    ).toBeUndefined();
    expect(
      usageResultTokens({
        uncached_input_tokens: 1,
        cache_read_input_tokens: -1,
        cache_creation: {},
        output_tokens: 0,
      })
    ).toBeUndefined();
  });
});

describe('token cross-check', () => {
  const DAY = '2026-10-14';

  /** Billed ledger totals: uncached 300, read 5000, write 800, output 900 */
  function writeTokenLedger(): void {
    writeAudit([
      spawn({
        micro: 1_000_000,
        start: `${DAY}T10:00:00Z`,
        usage: { input: 2_100, read: 1_500, write: 500, output: 400 },
      }),
      spawn({
        micro: 500_000,
        start: `${DAY}T11:00:00Z`,
        usage: { input: 4_000, read: 3_500, write: 300, output: 500 },
      }),
      // Subscription spawn: never compared
      spawn({
        micro: 9_000_000,
        basis: 'api_equivalent',
        start: `${DAY}T12:00:00Z`,
        usage: { input: 99_999, read: 0, write: 0, output: 99_999 },
      }),
    ]);
  }

  const MATCHING: UsageResult[] = [
    { uncached: 200, read: 5_000, w5m: 600, w1h: 0, output: 600 },
    { uncached: 100, read: 0, w5m: 0, w1h: 200, output: 300 },
    // Another workspace: ignored when scoped
    { uncached: 1e6, read: 1e6, w5m: 1e6, w1h: 1e6, output: 1e6, ws: 'w2' },
  ];

  function costFor(amount = '150'): () => MockResponse {
    return () => json(anthropicPage([{ day: DAY, amounts: [[amount, 'w1']] }]));
  }

  it('reports no drift when every token class matches', async () => {
    writeTokenLedger();
    const usageUrls: URL[] = [];
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: (url) => {
          usageUrls.push(url);
          return json(usagePage([{ day: DAY, results: MATCHING }]));
        },
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });

    expect(usageUrls).toHaveLength(1);
    const url = usageUrls[0];
    expect(url.searchParams.get('starting_at')).toBe(
      '2026-10-14T00:00:00.000Z'
    );
    expect(url.searchParams.get('ending_at')).toBe('2026-10-15T00:00:00.000Z');
    expect(url.searchParams.get('bucket_width')).toBe('1d');
    expect(url.searchParams.getAll('group_by[]')).toEqual(['workspace_id']);
    expect(url.searchParams.getAll('workspace_ids[]')).toEqual(['w1']);

    const a = row(report, 'anthropic', DAY);
    expect(a.status).toBe('ok');
    expect(a.tokens?.status).toBe('ok');
    expect(a.tokens?.driftClasses).toEqual([]);
    expect(a.tokens?.classes).toMatchObject({
      uncachedInput: { ledger: 300, provider: 300, drift: 0 },
      cacheRead: { ledger: 5_000, provider: 5_000, drift: 0 },
      cacheWrite: { ledger: 800, provider: 800, drift: 0 },
      output: { ledger: 900, provider: 900, drift: 0 },
    });
    expect(row(report, 'openai', DAY).tokens).toBeNull();

    const text = formatReconcileReport(report);
    expect(text).toContain('Anthropic token cross-check');
    expect(text).toContain('cache write');
    expect(text).toContain('5,000');
  });

  it('reports drift for the drifting class only', async () => {
    writeTokenLedger();
    const results = MATCHING.map((r, i) =>
      i === 0 ? { ...r, read: 10_000 } : r
    );
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: () => json(usagePage([{ day: DAY, results }])),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    const a = row(report, 'anthropic', DAY);
    // Dollars still reconcile; tokens catch the cache-read drift
    expect(a.status).toBe('ok');
    expect(a.tokens?.status).toBe('drift');
    expect(a.tokens?.driftClasses).toEqual(['cacheRead']);
    const read = a.tokens!.classes.cacheRead;
    expect(read.drift).toBe(-5_000);
    expect(read.driftPct).toBe(-50);
    expect(read.withinTolerance).toBe(false);
    for (const cls of ['uncachedInput', 'cacheWrite', 'output'] as const) {
      expect(a.tokens!.classes[cls].withinTolerance).toBe(true);
    }
    const lines = formatReconcileReport(report).split('\n');
    expect(lines.find((l) => l.includes('cache read'))).toContain('drift');
    expect(lines.find((l) => l.includes('cache write'))).not.toContain('drift');
  });

  it('bands estimated-token spawns and notes spawns with no tokens', async () => {
    writeAudit([
      spawn({
        micro: 1_000_000,
        start: `${DAY}T10:00:00Z`,
        usage: { input: 1_000, output: 1_000 },
        tokenProvenance: 'estimated',
      }),
      spawn({ micro: 500_000, start: `${DAY}T11:00:00Z` }),
    ]);
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: () =>
          json(
            usagePage([{ day: DAY, results: [{ uncached: 400, output: 0 }] }])
          ),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    const t = row(report, 'anthropic', DAY).tokens!;
    // Drift (600 / 1,000) is inside the estimated-token band
    expect(t.classes.uncachedInput.band).toBe(1_000);
    expect(t.classes.output.band).toBe(1_000);
    expect(t.status).toBe('ok');
    expect(t.missingTokenSpawns).toBe(1);
    expect(t.estimatedTokenSpawns).toBe(1);
    expect(t.notes.join(' ')).toMatch(
      /1 billed spawn\(s\) with no recorded tokens/
    );
  });

  it('excludes open (non-final) UTC days', async () => {
    const report = await reconcileUsage({
      date: '2026-10-16',
      days: 2,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: () => json(anthropicPage([])),
        anthropicUsage: () =>
          json(
            usagePage([
              { day: '2026-10-15', results: [] },
              { day: '2026-10-16', results: [{ uncached: 5, output: 5 }] },
            ])
          ),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    const open = row(report, 'anthropic', '2026-10-16').tokens!;
    expect(open.status).toBe('not-yet-final');
    expect(open.driftClasses).toEqual([]);
    expect(row(report, 'anthropic', '2026-10-15').tokens?.status).toBe('ok');

    // Just after midnight the closed day is still inside the 1h delay
    const early = await reconcileUsage({
      date: '2026-10-15',
      now: new Date('2026-10-16T00:30:00Z'),
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: () => json(anthropicPage([])),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    expect(row(early, 'anthropic', '2026-10-15').tokens?.status).toBe(
      'not-yet-final'
    );
  });

  it('selects the default workspace client-side without workspace_ids[]', async () => {
    writeAudit([
      spawn({
        micro: 1_000_000,
        start: `${DAY}T10:00:00Z`,
        usage: { input: 100, output: 50 },
      }),
    ]);
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: () =>
          json(anthropicPage([{ day: DAY, amounts: [['100', null]] }])),
        anthropicUsage: (url) => {
          expect(url.searchParams.has('workspace_ids[]')).toBe(false);
          return json(
            usagePage([
              {
                day: DAY,
                results: [
                  { uncached: 100, output: 50, ws: null },
                  { uncached: 7, output: 7, ws: 'w2' },
                ],
              },
            ])
          );
        },
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: ANTHROPIC_DEFAULT_WORKSPACE,
    });
    const t = row(report, 'anthropic', DAY).tokens!;
    expect(t.status).toBe('ok');
    expect(t.classes.uncachedInput.provider).toBe(100);
  });

  it('fails closed when the usage endpoint errors, keeping the dollar row', async () => {
    writeTokenLedger();
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: () => ({
          ok: false,
          status: 500,
          json: async () => ({ detail: `RAW_BODY_MARKER ${ANTHROPIC_KEY}` }),
          body: null,
        }),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    const a = row(report, 'anthropic', DAY);
    expect(a.status).toBe('ok');
    expect(a.tokens?.status).toBe('error');
    expect(a.tokens?.notes).toContain('HTTP 500');
    expect(a.tokens?.classes.cacheRead).toMatchObject({
      ledger: 5_000,
      provider: null,
      drift: null,
      withinTolerance: null,
    });
    expect(report.warnings.join('\n')).toMatch(
      /anthropic: usage report failed \(HTTP 500\)/
    );
    const serialized = JSON.stringify(report) + formatReconcileReport(report);
    expect(serialized).not.toContain('RAW_BODY_MARKER');
    expect(serialized).not.toContain('SECRET');
  });

  it('fails closed on unscoped or unparsable usage data', async () => {
    writeTokenLedger();
    const ungrouped = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: () => {
          const page = usagePage([{ day: DAY, results: MATCHING }]) as {
            data: Array<{ results: Array<Record<string, unknown>> }>;
          };
          delete page.data[0].results[0].workspace_id;
          return json(page);
        },
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    const t = row(ungrouped, 'anthropic', DAY).tokens!;
    expect(t.status).toBe('error');
    expect(t.notes).toContain('result not grouped by workspace');

    const malformed = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: () =>
          json({
            data: [
              {
                starting_at: `${DAY}T00:00:00Z`,
                results: [{ workspace_id: 'w1', output_tokens: 1 }],
              },
            ],
            has_more: false,
          }),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    expect(row(malformed, 'anthropic', DAY).tokens?.notes).toContain(
      'unparsable token count'
    );

    // No scope at all: compared but non-attributable, like the dollar row
    const unscoped = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: (url) => {
          expect(url.searchParams.has('workspace_ids[]')).toBe(false);
          return json(usagePage([{ day: DAY, results: MATCHING }]));
        },
      }) as unknown as FetchLike,
      auditDir,
    });
    const u = row(unscoped, 'anthropic', DAY).tokens!;
    expect(u.status).toBe('non-attributable');
    expect(u.driftClasses).toEqual([]);
    // Org-wide totals include the other workspace
    expect(u.classes.output.provider).toBe(1_000_900);
  });

  it('is non-reconcilable without an admin key', async () => {
    writeTokenLedger();
    const fetchImpl = vi.fn();
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: {},
      fetchImpl: fetchImpl as unknown as FetchLike,
      auditDir,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const t = row(report, 'anthropic', DAY).tokens!;
    expect(t.status).toBe('non-reconcilable');
    expect(t.classes.output.ledger).toBe(900);
  });

  it('sums every usage page and enforces the page cap', async () => {
    writeTokenLedger();
    const seen: Array<string | null> = [];
    const pages = [
      usagePage([{ day: DAY, results: [MATCHING[0]] }], 'u2'),
      usagePage([{ day: DAY, results: [MATCHING[1]] }]),
    ];
    const report = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: (url) => {
          seen.push(url.searchParams.get('page'));
          return json(pages[seen.length - 1]);
        },
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
    });
    expect(seen).toEqual([null, 'u2']);
    const t = row(report, 'anthropic', DAY).tokens!;
    expect(t.status).toBe('ok');
    expect(t.classes.cacheWrite.provider).toBe(800);

    const capped = await reconcileUsage({
      date: DAY,
      now: NOW,
      env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_KEY },
      fetchImpl: mockFetch({
        anthropic: costFor(),
        anthropicUsage: () =>
          json(usagePage([{ day: DAY, results: [MATCHING[0]] }], 'more')),
      }) as unknown as FetchLike,
      auditDir,
      anthropicWorkspace: 'w1',
      pageCap: 3,
    });
    const c = row(capped, 'anthropic', DAY);
    expect(c.status).toBe('ok');
    expect(c.tokens?.status).toBe('error');
    expect(c.tokens?.notes.join(' ')).toMatch(/page cap \(3\)/);
  });
});

describe('reconcileCommand', () => {
  it('exits 0 with a non-reconcilable notice when keys are missing', async () => {
    const DAY = '2026-10-14';
    writeAudit([spawn({ micro: 1_000_000, start: `${DAY}T10:00:00Z` })]);
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reconcileCommand({
      date: DAY,
      now: NOW,
      env: {},
      auditDir,
      json: true,
    });
    expect(exit).toHaveBeenCalledWith(0);
    const out = JSON.parse(String(log.mock.calls[0][0])) as ReconcileReport;
    expect(out.rows.every((r) => r.status === 'non-reconcilable')).toBe(true);
    const tokens = out.rows.find((r) => r.provider === 'anthropic')?.tokens;
    expect(tokens?.status).toBe('non-reconcilable');
    expect(Object.keys(tokens?.classes ?? {})).toEqual([
      'uncachedInput',
      'cacheRead',
      'cacheWrite',
      'output',
    ]);
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /non-reconcilable/
    );
  });

  it('exits 1 on invalid options', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await reconcileCommand({ date: 'yesterday', now: NOW, env: {}, auditDir });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
