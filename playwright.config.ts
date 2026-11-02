import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
for (const [name, value] of Object.entries(
  parseEnv(readFileSync('.env', 'utf8')),
))
  process.env[name] ??= value;
// Quality suite (visual/a11y/responsive) renders in the pinned Playwright container
// when CATUS_PW_WS points at its run-server, so screenshots match CI exactly.
const remote = process.env.CATUS_PW_WS
  ? { connectOptions: { wsEndpoint: process.env.CATUS_PW_WS } }
  : {};
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  snapshotPathTemplate: '{testDir}/quality/__screenshots__/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Exact match in the pinned renderer; any approved change needs new baselines.
      maxDiffPixels: 0,
    },
  },
  projects: [
    { name: 'journeys', testIgnore: /quality\// },
    {
      name: 'quality-setup',
      testMatch: /quality\/seed\.setup\.ts/,
      use: remote,
    },
    {
      name: 'quality',
      testMatch: /quality\/.*\.spec\.ts/,
      dependencies: ['quality-setup'],
      use: {
        ...remote,
        locale: 'pt-BR',
        timezoneId: 'UTC',
        colorScheme: 'light',
      },
    },
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    launchOptions: process.env.CHROMIUM_PATH
      ? {
          executablePath: process.env.CHROMIUM_PATH,
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote'],
        }
      : {},
  },
  webServer: [
    {
      command:
        'NODE_ENV=test node_modules/.bin/bun tests/support/browser-server.ts',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
    {
      command: 'npm run web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
});
