import { describe, expect, it } from 'vitest';
import { EntrySearch, highlight, usageScore } from '../../../src/renderer/lib/search';
import { EntryPathSchema } from '../../../src/shared/types';

const paths = (...names: string[]) => names.map((name) => EntryPathSchema.parse(name));
const NOW = 1_700_000_000_000;

describe('EntrySearch', () => {
  const entries = paths(
    'web/github.com/alice',
    'web/gitlab.com/alice',
    'github',
    'mail/proton',
    'work/git-server',
    'bank/gift-card',
  );
  const search = new EntrySearch(entries);

  it('ranks exact, then prefix, then substring, then fuzzy matches', () => {
    const results = search.search('github', {}, NOW);
    expect(results.map((hit) => [hit.path, hit.tier])).toEqual(
      [
        ['github', 0],
        ['web/github.com/alice', 1],
      ].concat(results.slice(2).map((hit) => [hit.path, hit.tier])),
    );
    expect(results[0]?.ranges).toEqual([[0, 5]]);
    expect(results[1]?.ranges).toEqual([[4, 9]]);
  });

  it('matches the last segment exactly and highlights it', () => {
    const [first] = search.search('alice', {}, NOW);
    expect(first?.tier).toBe(0);
    const length = first?.path.length ?? 0;
    expect(first?.ranges).toEqual([[length - 5, length - 1]]);
  });

  it('finds fuzzy matches with typos and normalises separators', () => {
    expect(search.search('protn', {}, NOW).map((hit) => hit.path)).toContain('mail/proton');
    expect(search.search('mail\\proton', {}, NOW)[0]?.path).toBe('mail/proton');
    expect(search.search('zzzzzz', {}, NOW)).toEqual([]);
  });

  it('breaks ties with usage frequency and recency', () => {
    const history = {
      'web/gitlab.com/alice': { count: 10, last: NOW - 1000 },
      'web/github.com/alice': { count: 1, last: NOW - 90 * 86_400_000 },
    };
    expect(search.search('alice', history, NOW).map((hit) => hit.path)).toEqual([
      'web/gitlab.com/alice',
      'web/github.com/alice',
    ]);
    expect(
      search
        .search('', history, NOW)
        .slice(0, 2)
        .map((hit) => hit.path),
    ).toEqual(['web/gitlab.com/alice', 'web/github.com/alice']);
    expect(search.search('', {}, NOW).map((hit) => hit.path)).toEqual(
      [...entries].sort((a, b) => a.localeCompare(b)),
    );
    expect(usageScore(history, 'nope', NOW)).toBe(0);
    expect(usageScore(history, 'web/gitlab.com/alice', NOW)).toBeGreaterThan(
      usageScore(history, 'web/github.com/alice', NOW),
    );
  });

  it('handles 5,000+ entries quickly', () => {
    const many = Array.from({ length: 6000 }, (_, index) =>
      EntryPathSchema.parse(`site${String(index)}/user${String(index % 37)}`),
    );
    const big = new EntrySearch(many);
    const started = performance.now();
    const results = big.search('site4242', {}, NOW);
    expect(results[0]?.path).toBe('site4242/user24');
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('highlight', () => {
  it('splits text into marked and plain parts', () => {
    expect(highlight('github', [[0, 2]])).toEqual([
      { text: 'git', hit: true },
      { text: 'hub', hit: false },
    ]);
    expect(
      highlight('abc', [
        [-5, 0],
        [2, 99],
      ]),
    ).toEqual([
      { text: 'a', hit: true },
      { text: 'b', hit: false },
      { text: 'c', hit: true },
    ]);
    expect(highlight('', [])).toEqual([]);
  });
});
