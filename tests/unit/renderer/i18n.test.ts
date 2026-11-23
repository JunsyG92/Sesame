import { describe, expect, it } from 'vitest';
import { createI18n, errorMessage } from '../../../src/renderer/i18n';
import { en } from '../../../src/renderer/i18n/en';
import { fr } from '../../../src/renderer/i18n/fr';
import { AppErrorSchema, type AppError } from '../../../src/shared/errors';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('i18n', () => {
  it('French and English define exactly the same keys', () => {
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });

  it('translates every error kind without leaking raw payloads', () => {
    const kinds = AppErrorSchema.options.map((option) => option.shape.kind.value);
    const sample: Record<string, AppError> = {};
    for (const kind of kinds) {
      const candidate = {
        kind,
        message: 'detail',
        path: 'web/a',
        reason: 'traversal',
        accelerator: 'Alt+K',
      };
      const parsed = AppErrorSchema.safeParse(candidate);
      if (parsed.success) sample[kind] = parsed.data;
    }
    for (const locale of ['en', 'fr'] as const) {
      const t = createI18n(locale).t;
      for (const error of Object.values(sample)) {
        const message = errorMessage(t, error);
        expect(message).not.toMatch(/errors\.|pathReasons\.|\{\{/);
        expect(message.length).toBeGreaterThan(3);
      }
    }
    expect(errorMessage(createI18n('fr').t, { kind: 'invalid-path', reason: 'traversal' })).toBe(
      'Nom invalide (« .. » est interdit).',
    );
  });
});
