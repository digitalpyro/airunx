/**
 * Environment filtering shared by every child-process spawn path.
 *
 * Provider admin keys (cost/usage APIs) are read only by `costs reconcile`
 * in-process. They must never reach a child: agent CLIs, agent-authored test
 * scripts, dependency installs or CLI auth-status checks.
 */

/** Never passed to any child process */
export const PROVIDER_ADMIN_KEY_DENYLIST: readonly string[] = Object.freeze([
  'ANTHROPIC_ADMIN_KEY',
  'OPENAI_ADMIN_KEY',
]);

/** Copy of `env` with provider admin keys removed (input is not mutated) */
export function withoutProviderAdminKeys(
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = { ...env };
  for (const key of PROVIDER_ADMIN_KEY_DENYLIST) {
    delete filtered[key];
  }
  return filtered;
}
