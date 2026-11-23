import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const strict = { lines: 90, branches: 90, functions: 90, statements: 90 };

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // Thin Electron glue (windows, tray, lifecycle, IPC wiring, preload) and the
        // renderer bootstrap need a real Electron runtime: they are exercised by the
        // Playwright end-to-end suite instead of unit tests.
        'src/main/index.ts',
        'src/main/app/**',
        'src/preload/**',
        'src/renderer/**/main.tsx',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        'src/main/store/**': strict,
        'src/main/generator.ts': strict,
        'src/main/clipboard.ts': strict,
        'src/shared/entryPath.ts': strict,
      },
    },
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['tests/unit/main/**/*.test.ts', 'tests/unit/shared/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/unit/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/unit/renderer/setup.ts'],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
