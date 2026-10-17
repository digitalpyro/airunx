/**
 * Human-readable rendering of a RunCostSummary for `airunx costs`.
 * Figures are computed in micro-USD and only converted to dollars here.
 */

import chalk from 'chalk';
import type {
  CostTotals,
  RunCostSummary,
} from '../../core/run-cost-summary.js';
import { formatMicroUsd } from '../../core/cost-accounting.js';

// Re-exported so existing importers keep working; defined in cost-accounting
export { formatMicroUsd };

function mixCell(t: CostTotals): string {
  if (t.totalMicroUsd <= 0) {
    return t.missingCostSpawns > 0 ? 'unknown' : '-';
  }
  const m = t.provenanceMix;
  return `${m.reportedPct}/${m.derivedPct}/${m.estimatedPct}`;
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  // First column left-aligned, the rest right-aligned
  const line = (cells: string[]): string =>
    '  ' +
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join('  ');
  return [
    chalk.bold(line(headers)),
    `  ${'─'.repeat(widths.reduce((a, w) => a + w, 0) + 2 * (widths.length - 1))}`,
    ...rows.map(line),
  ];
}

/** Render the full single-run cost view */
export function formatRunCosts(summary: RunCostSummary): string {
  const out: string[] = [];
  const t = summary.totals;

  out.push(chalk.blue.bold(`\nAIRunX Costs — ${summary.workflowId}`));
  out.push(
    chalk.dim(
      `  Status: ${summary.status ?? 'unknown'} | Source: ${summary.source} | Spawn events: ${summary.ledgerSpawnEvents}`
    )
  );

  out.push('');
  out.push(chalk.bold('Totals'));
  out.push(`  Billed:          ${formatMicroUsd(t.billedMicroUsd)}`);
  out.push(`  API-equivalent:  ${formatMicroUsd(t.apiEquivalentMicroUsd)}`);
  if (t.unknownBasisMicroUsd > 0) {
    out.push(`  Unknown basis:   ${formatMicroUsd(t.unknownBasisMicroUsd)}`);
  }
  out.push(
    `  Provenance:      ${t.provenanceMix.reportedPct}% reported, ${t.provenanceMix.derivedPct}% derived, ${t.provenanceMix.estimatedPct}% estimated`
  );
  if (t.missingCostSpawns > 0) {
    out.push(
      chalk.yellow(`  Unknown cost:    ${t.missingCostSpawns} spawn(s)`)
    );
  }
  out.push(chalk.dim(`  ${summary.summaryLine}`));

  if (summary.stages.length > 0) {
    out.push('');
    out.push(chalk.bold('Per stage'));
    out.push(
      ...renderTable(
        ['Stage', 'Cost', 'Billed', 'API-eq', 'Spawns', 'R/D/E %', 'Source'],
        summary.stages.map((s) => [
          s.stage,
          formatMicroUsd(s.totalMicroUsd),
          formatMicroUsd(s.billedMicroUsd),
          formatMicroUsd(s.apiEquivalentMicroUsd),
          String(s.spawnCount),
          mixCell(s),
          s.source,
        ])
      )
    );
  }

  out.push('');
  out.push(chalk.bold('Top drivers'));
  if (summary.drivers.length === 0) {
    out.push(chalk.dim('  none (no delegation, re-runs, retries or kills)'));
  } else {
    out.push(
      ...renderTable(
        ['Driver', 'Cost', 'Count'],
        summary.drivers.map((d) => [
          d.label,
          formatMicroUsd(d.microUsd),
          String(d.count),
        ])
      )
    );
  }

  if (summary.notices.length > 0) {
    out.push('');
    for (const notice of summary.notices) {
      out.push(chalk.yellow(`  [notice] ${notice}`));
    }
  }

  return out.join('\n');
}
