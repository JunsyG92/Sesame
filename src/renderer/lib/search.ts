import Fuse from 'fuse.js';
import { lastSegment, normalizeEntryPath } from '../../shared/entryPath';
import type { UsageHistory } from '../../shared/schemas';
import type { EntryPath } from '../../shared/types';

export type Range = readonly [start: number, end: number];

export interface SearchHit {
  readonly path: EntryPath;
  /** Inclusive character ranges to highlight. */
  readonly ranges: readonly Range[];
  /** 0 exact, 1 prefix, 2 substring, 3 fuzzy (an empty query lists everything as 3). */
  readonly tier: 0 | 1 | 2 | 3;
}

const DAY_MS = 86_400_000;

/** Frequency with a recency decay (half-life of two weeks). */
export function usageScore(history: UsageHistory, path: string, now: number): number {
  const usage = history[path];
  if (usage === undefined) return 0;
  const ageDays = Math.max(0, now - usage.last) / DAY_MS;
  return usage.count * 0.5 ** (ageDays / 14) + 1 / (1 + ageDays);
}

function substringRanges(path: string, needle: string): Range[] {
  const index = path.toLowerCase().indexOf(needle);
  return index === -1 ? [] : [[index, index + needle.length - 1]];
}

/** 0 = exact, 1 = prefix of the path or of a segment, 2 = substring, null = none. */
function tier(path: string, needle: string): 0 | 1 | 2 | null {
  const lower = path.toLowerCase();
  if (lower === needle || lastSegment(lower) === needle) return 0;
  if (lower.startsWith(needle) || lower.split('/').some((part) => part.startsWith(needle))) {
    return 1;
  }
  return lower.includes(needle) ? 2 : null;
}

/**
 * Searches entry names only (nothing is ever decrypted for searching).
 * Ranking: exact match, then prefix, then substring, then fuzzy matches; ties
 * are broken by usage frequency/recency, then alphabetically.
 */
export class EntrySearch {
  private readonly fuse: Fuse<EntryPath>;

  public constructor(private readonly entries: readonly EntryPath[]) {
    this.fuse = new Fuse(entries, {
      includeMatches: true,
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.4,
      minMatchCharLength: 1,
    });
  }

  public search(query: string, history: UsageHistory, now: number): SearchHit[] {
    const needle = normalizeEntryPath(query).toLowerCase();
    const usage = (path: string): number => usageScore(history, path, now);
    if (needle === '') {
      return [...this.entries]
        .sort((a, b) => usage(b) - usage(a) || a.localeCompare(b))
        .map((path) => ({ path, ranges: [], tier: 3 as const }));
    }
    const ranked = new Map<
      EntryPath,
      { tier: SearchHit['tier']; score: number; ranges: Range[] }
    >();
    for (const path of this.entries) {
      const found = tier(path, needle);
      if (found !== null) {
        const ranges =
          found === 0 && path.toLowerCase() !== needle
            ? [[path.length - needle.length, path.length - 1] as const]
            : substringRanges(path, needle);
        ranked.set(path, { tier: found, score: 0, ranges });
      }
    }
    for (const result of this.fuse.search(needle)) {
      if (ranked.has(result.item)) continue;
      const ranges = (result.matches ?? []).flatMap((match) => match.indices);
      ranked.set(result.item, { tier: 3, score: result.score ?? 1, ranges });
    }
    return [...ranked.entries()]
      .sort(
        ([pathA, a], [pathB, b]) =>
          a.tier - b.tier ||
          usage(pathB) - usage(pathA) ||
          a.score - b.score ||
          pathA.localeCompare(pathB),
      )
      .map(([path, { ranges, tier: found }]) => ({ path, ranges, tier: found }));
  }
}

/** Splits a label into highlighted and plain parts. */
export function highlight(
  text: string,
  ranges: readonly Range[],
): { text: string; hit: boolean }[] {
  const marks = new Array<boolean>(text.length).fill(false);
  for (const [start, end] of ranges) {
    for (let index = Math.max(0, start); index <= Math.min(end, text.length - 1); index += 1) {
      marks[index] = true;
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const hit = marks[index] === true;
    const last = parts.at(-1);
    if (last?.hit === hit) parts[parts.length - 1] = { text: last.text + text.charAt(index), hit };
    else parts.push({ text: text.charAt(index), hit });
  }
  return parts;
}
