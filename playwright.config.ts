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
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote',
          ],
        }
      : {},
  },
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
    },
  ],
  reporter: 'list',
});
