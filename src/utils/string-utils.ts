/**
 * String Utility Functions
 *
 * Shared string manipulation utilities used across the codebase,
 * including fuzzy matching and distance calculations.
 */

/**
 * Calculate Levenshtein distance between two strings
 *
 * The Levenshtein distance is the minimum number of single-character edits
 * (insertions, deletions, or substitutions) required to change one string into another.
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Get the closest match from an array of candidate strings
 *
 * Uses Levenshtein distance to find the closest match. Returns null if
 * no candidate is within the maximum distance threshold (default: 3).
 *
 * @param value - The input string to match
 * @param candidates - Array of candidate strings to match against
 * @param maxDistance - Maximum Levenshtein distance for a valid match (default: 3)
 * @returns The closest matching candidate, or null if none found within threshold
 */
export function getClosestMatch(
  value: string,
  candidates: readonly string[],
  maxDistance: number = 3
): string | null {
  if (candidates.length === 0) return null;

  let minDistance = Infinity;
  let closest: string | null = null;

  for (const candidate of candidates) {
    const distance = levenshteinDistance(
      value.toLowerCase(),
      candidate.toLowerCase()
    );
    if (distance < minDistance && distance <= maxDistance) {
      minDistance = distance;
      closest = candidate;
    }
  }

  return closest;
}
