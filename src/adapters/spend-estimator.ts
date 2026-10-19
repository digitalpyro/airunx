/**
 * Kill-time spend estimation
 *
 * A CLI killed (timeout, hang, signal) before it prints its result JSON
 * leaves no cost figure, yet the provider has billed for the work done. This
 * module estimates that lost spend, bounded on both sides:
 *
 *   active time  = spawn start → last observed stdout/stderr output
 *                  (never kill time, so idle wall clock is not billed)
 *   raw estimate = active seconds × burn rate (USD/s)
 *   floor        = prompt bytes ÷ KILL_ESTIMATE_BYTES_PER_TOKEN × input price
 *                  (the prompt was sent at least once)
 *   cap          = the run's largest observed per-spawn cost, or
 *                  floor × KILL_ESTIMATE_CAP_FLOOR_MULTIPLIER when none
 *   estimate     = clamp(raw, floor, max(cap, floor))
 *
 * Burn rate sources, in order: completed spawns of the same backend in this
 * process, completed spawns of any backend in this process, the median
 * per-stage rate of recent run reports on disk for the backend; with none of
 * these the estimate is the floor alone. The result is always `estimated`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { RUN_REPORTS_DIR } from '../utils/workflow-id.js';

/** Estimation method tag recorded on kill-time estimates */
export const KILL_TIME_ESTIMATION_METHOD = 'kill_time';

/** Prompt bytes per token for the floor (the usual chars÷4 heuristic) */
export const KILL_ESTIMATE_BYTES_PER_TOKEN = 4;

/** Cap multiple of the floor when no spawn cost has been observed yet */
export const KILL_ESTIMATE_CAP_FLOOR_MULTIPLIER = 10;

/**
 * Completed spawns shorter than this are ignored for burn rate (their
 * cost/duration ratio is dominated by fixed startup cost)
 */
export const MIN_BURN_RATE_SAMPLE_MS = 1_000;

/** Number of most-recent run report files sampled for the historical rate */
export const HISTORICAL_REPORT_SAMPLE_SIZE = 20;

/** Where a burn rate came from */
export type BurnRateSource = 'run_backend' | 'run' | 'history' | 'none';

/** A completed spawn's spend, observed in this process */
export interface SpendObservation {
  backend: string;
  costUsd: number;
  /** Spawn start → last output (or end, for a clean exit) */
  activeMs: number;
}

/** Inputs for one kill-time estimate */
export interface KillTimeEstimateInput {
  backend: string;
  /** Spawn start → last observed output (0 when there was no output) */
  activeMs: number;
  promptBytes: number;
  /** Input price of the spawn's model, USD per 1M tokens */
  inputPricePer1M: number;
}

/** A kill-time estimate and how it was bounded */
export interface KillTimeEstimate {
  costUsd: number;
  floorUsd: number;
  capUsd: number;
  burnRateUsdPerSec?: number;
  rateSource: BurnRateSource;
  bound: 'floor' | 'cap' | 'rate';
}

const totals = (
  observations: SpendObservation[]
): { costUsd: number; activeMs: number } =>
  observations.reduce(
    (acc, o) => ({
      costUsd: acc.costUsd + o.costUsd,
      activeMs: acc.activeMs + o.activeMs,
    }),
    { costUsd: 0, activeMs: 0 }
  );

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Per-process record of completed spawns' spend. One `airunx run` process is
 * one run, so a module-level instance is the run's burn-rate tracker.
 */
export class SpendTracker {
  private observations: SpendObservation[] = [];
  private maxSpawnCostUsd: number | undefined;
  private historyCache = new Map<string, number | undefined>();
  private reportsDir: string | null = RUN_REPORTS_DIR;

  /** Record a completed spawn with a reported or derived cost */
  record(observation: SpendObservation): void {
    if (!Number.isFinite(observation.costUsd) || observation.costUsd <= 0) {
      return;
    }
    this.maxSpawnCostUsd = Math.max(
      this.maxSpawnCostUsd ?? 0,
      observation.costUsd
    );
    if (observation.activeMs >= MIN_BURN_RATE_SAMPLE_MS) {
      this.observations.push(observation);
    }
  }

  /** Largest per-spawn cost observed in this run */
  largestSpawnCostUsd(): number | undefined {
    return this.maxSpawnCostUsd;
  }

  /** USD/s for the backend, with its source */
  burnRate(backend: string): {
    rate?: number;
    source: BurnRateSource;
  } {
    const sameBackend = totals(
      this.observations.filter((o) => o.backend === backend)
    );
    if (sameBackend.activeMs > 0) {
      return {
        rate: sameBackend.costUsd / (sameBackend.activeMs / 1000),
        source: 'run_backend',
      };
    }
    const all = totals(this.observations);
    if (all.activeMs > 0) {
      return { rate: all.costUsd / (all.activeMs / 1000), source: 'run' };
    }
    const historical = this.historicalRate(backend);
    if (historical !== undefined) {
      return { rate: historical, source: 'history' };
    }
    return { source: 'none' };
  }

  /**
   * Median per-stage USD/s for the backend across the most recent run
   * reports (cached per backend). Unreadable files are skipped.
   */
  historicalRate(backend: string): number | undefined {
    if (this.historyCache.has(backend)) return this.historyCache.get(backend);
    let rate: number | undefined;
    try {
      rate = this.readHistoricalRate(backend);
    } catch {
      rate = undefined;
    }
    this.historyCache.set(backend, rate);
    return rate;
  }

  private readHistoricalRate(backend: string): number | undefined {
    const dir = this.reportsDir;
    if (!dir || !existsSync(dir)) return undefined;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const path = join(dir, f);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((f): f is { path: string; mtimeMs: number } => f !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, HISTORICAL_REPORT_SAMPLE_SIZE);

    const rates: number[] = [];
    for (const file of files) {
      try {
        const report = JSON.parse(readFileSync(file.path, 'utf-8')) as {
          stages?: unknown;
        };
        if (!Array.isArray(report.stages)) continue;
        for (const stage of report.stages as Array<Record<string, unknown>>) {
          const cost = stage.costUsd;
          const duration = stage.durationMs;
          if (
            stage.backend === backend &&
            typeof cost === 'number' &&
            typeof duration === 'number' &&
            cost > 0 &&
            duration >= MIN_BURN_RATE_SAMPLE_MS
          ) {
            rates.push(cost / (duration / 1000));
          }
        }
      } catch {
        // Skip unreadable / partial report files
      }
    }
    return median(rates);
  }

  /** Directory scanned for the historical rate (null disables it) */
  setReportsDir(dir: string | null): void {
    this.reportsDir = dir;
    this.historyCache.clear();
  }

  /** Forget all observations (tests) */
  reset(): void {
    this.observations = [];
    this.maxSpawnCostUsd = undefined;
    this.historyCache.clear();
    this.reportsDir = RUN_REPORTS_DIR;
  }

  /** Estimate a killed spawn's spend (see module doc for the formula) */
  estimateKillTimeSpend(input: KillTimeEstimateInput): KillTimeEstimate {
    const floorUsd =
      (Math.max(0, input.promptBytes) / KILL_ESTIMATE_BYTES_PER_TOKEN) *
      (Math.max(0, input.inputPricePer1M) / 1_000_000);
    const observedCap = this.largestSpawnCostUsd();
    const capUsd = Math.max(
      observedCap ?? floorUsd * KILL_ESTIMATE_CAP_FLOOR_MULTIPLIER,
      floorUsd
    );
    const { rate, source } = this.burnRate(input.backend);
    if (rate === undefined || input.activeMs <= 0) {
      return {
        costUsd: floorUsd,
        floorUsd,
        capUsd,
        burnRateUsdPerSec: rate,
        rateSource: source,
        bound: 'floor',
      };
    }
    const raw = (input.activeMs / 1000) * rate;
    let costUsd = raw;
    let bound: KillTimeEstimate['bound'] = 'rate';
    if (raw <= floorUsd) {
      costUsd = floorUsd;
      bound = 'floor';
    } else if (raw >= capUsd) {
      costUsd = capUsd;
      bound = 'cap';
    }
    return {
      costUsd,
      floorUsd,
      capUsd,
      burnRateUsdPerSec: rate,
      rateSource: source,
      bound,
    };
  }
}

/** The process-wide (= run-wide) tracker used by CLI adapters */
export const runSpendTracker = new SpendTracker();
