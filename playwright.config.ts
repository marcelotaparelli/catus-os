import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
for (const [name, value] of Object.entries(
  parseEnv(readFileSync('.env', 'utf8')),
))
  process.env[name] ??= value;
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  use: {
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
  reporter: 'list',
});
