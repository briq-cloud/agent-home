import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real-browser regression using an isolated profile. Every HTTP request is
// intercepted: this never starts a vendor login or probes real accounts.
const modulePath = process.env.RUNNER_PLAYWRIGHT_MODULE;
const browserPath =
  process.env.RUNNER_CHROME_BIN ??
  [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => existsSync(path));
test(
  'guided sign-in progresses independently of status scans and preserves unrelated input',
  {
    skip: !browserPath && 'No Chrome/Chromium binary installed for the isolated browser regression',
    timeout: 30_000,
  },
  async (t) => {
    const { chromium } = modulePath ? await import(pathToFileURL(modulePath).href) : await import('playwright-core');
    const browser = await chromium.launch({ headless: true, executablePath: browserPath });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1180, height: 950 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    });
    const files = new Map(
      await Promise.all(
        [
          ['/', '../src/ui/web/index.html'],
          ['/assets/home.js', '../src/ui/web/home.js'],
          ['/assets/fleet.js', '../src/ui/web/fleet.js'],
          ['/assets/extensions.js', '../src/ui/web/extensions.js'],
          ['/assets/home.css', '../src/ui/web/home.css'],
        ].map(
          async ([url, path]) => [url, await readFile(fileURLToPath(new URL(path!, import.meta.url)), 'utf8')] as const,
        ),
      ),
    );
    const states: Record<string, Record<string, unknown>> = { claude: { state: 'idle' }, codex: { state: 'idle' } };
    let holdStatus = false,
      statusHeld = false,
      releaseStatus: (() => void) | undefined;
    let claudeSignedInOverride: boolean | undefined;
    let codexSignedIn = false,
      failCode = false,
      delayedPolls = false,
      concurrentPolls = 0,
      maxConcurrentPolls = 0;
    const polls: Record<string, number> = { claude: 0, codex: 0 },
      starts: unknown[] = [],
      inputs: unknown[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const request = route.request(),
        path = new URL(request.url()).pathname,
        method = request.method();
      const fulfill = async (body: unknown, status = 200) => {
        try {
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        } catch {}
      };
      if (files.has(path))
        return route.fulfill({
          contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
          body: files.get(path),
        });
      if (path.startsWith('/assets/icons/'))
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#416d3b"/></svg>',
        });
      if (path === '/status') {
        if (holdStatus) {
          statusHeld = true;
          await new Promise<void>((resolve) => {
            releaseStatus = resolve;
          });
        }
        return fulfill({
          clis: [
            ...['claude', 'codex'].map((name) => ({
              name,
              signInWith: 'page',
              signedIn: name === 'claude' ? (claudeSignedInOverride ?? states.claude!.state === 'done') : codexSignedIn,
              signIn: states[name]!.state,
              statusSource: 'command',
            })),
            { name: 'vibe', signInWith: 'page', signedIn: null, signIn: 'idle', statusSource: 'acp' },
            { name: 'copilot', signInWith: 'page', signedIn: true, signIn: 'idle', statusSource: 'sign-in' },
          ],
          limited: {},
          features: { orchestrator: true },
        });
      }
      if (path === '/keys')
        return fulfill({
          providers: [{ id: 'openrouter', name: 'OpenRouter', set: false, billing: 'use', harnesses: ['claude'] }],
          profiles: [],
        });
      if (path === '/usage') return fulfill({ clis: [] });
      if (path === '/tasks') return fulfill({ tasks: [], nextOffset: null });
      if (path === '/projects') return fulfill({ projects: [{ id: 'home', root: '/work', revision: 'test' }] });
      if (path === '/features')
        return fulfill({
          orchestrator: true,
          delegation: false,
          concurrency: { coordinators: 1, children: 1, maxDepth: 1 },
        });
      const login = /^\/connect\/(claude|codex)(\/input)?$/.exec(path);
      if (login) {
        const name = login[1]!;
        if (login[2]) {
          inputs.push(request.postDataJSON());
          if (failCode) states[name] = { state: 'failed', reason: 'command_failed' };
          return fulfill(states[name]);
        }
        if (method === 'POST') {
          starts.push({ name, body: request.postDataJSON() });
          states[name] = {
            state: 'waiting',
            url: 'https://auth.example.test/authorize?fake-state=test',
            code: 'ABCD-EFGH',
          };
        } else if (method === 'DELETE') states[name] = { state: 'failed', reason: 'cancelled' };
        else {
          polls[name] = polls[name]! + 1;
          concurrentPolls++;
          maxConcurrentPolls = Math.max(maxConcurrentPolls, concurrentPolls);
          if (delayedPolls) await new Promise((resolve) => setTimeout(resolve, 750));
          concurrentPolls--;
        }
        return fulfill(states[name]);
      }
      return fulfill({ error: 'unexpected mocked route' }, 404);
    });
    await page.goto('http://signin.test/');
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const claude = page.locator('[data-agent="claude"]');
    await page
      .locator('[data-agent="vibe"]')
      .getByText('Sign-in check unavailable · try again shortly', { exact: true })
      .waitFor();
    await page.locator('[data-agent="copilot"]').getByText('Sign-in recorded', { exact: true }).waitFor();
    await page
      .locator('[data-agent="copilot"]')
      .getByRole('link', { name: 'Check account in terminal: open Copilot, then /user ↗' })
      .waitFor();
    const draft = page.getByLabel('OpenRouter key');
    await draft.fill('fake-unsaved-key-draft');
    await claude.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: 'Open Claude Code sign-in ↗' }).waitFor();
    assert.deepEqual(starts[0], { name: 'claude', body: { wait: false } });
    assert.equal(await claude.locator('.signin-host').textContent(), 'Sign in with Claude Code at auth.example.test');
    assert.equal(
      await claude.getByText('ABCD-EFGH', { exact: true }).count(),
      0,
      'Claude must not present a regex-matched OAuth state as a device code',
    );
    await claude.getByRole('button', { name: 'Copy link', exact: true }).click();
    await claude.getByText('Sign-in link copied', { exact: true }).waitFor();
    await page.getByLabel('Claude confirmation code').fill('fake-confirmation-code');
    holdStatus = true;
    await page.waitForFunction(() => true); // Let the ordinary status interval reach its deliberately slow response.
    const until = Date.now() + 7000;
    while (!statusHeld && Date.now() < until) await page.waitForTimeout(25);
    assert.ok(statusHeld, 'background status request must remain pending during confirmation');
    await claude.getByRole('button', { name: 'Confirm code', exact: true }).click();
    await page.getByText('Finishing sign-in…', { exact: true }).waitFor({ timeout: 1000 });
    assert.equal(await claude.getByRole('button', { name: 'Confirming…', exact: true }).isDisabled(), true);
    assert.equal(inputs.length, 1, 'duplicate confirmation must be disabled');
    states.claude = { state: 'done' };
    await page.getByText('Connected to Claude Code', { exact: true }).waitFor({ timeout: 1500 });
    assert.equal(
      await page.getByLabel('Claude confirmation code').count(),
      0,
      'completed steps must clear without blurring a button',
    );
    assert.equal(await draft.inputValue(), 'fake-unsaved-key-draft');
    // A status refresh for another card must preserve the actively edited field.
    await draft.focus();
    codexSignedIn = true;
    claudeSignedInOverride = false;
    holdStatus = false;
    releaseStatus?.();
    await page.locator('[data-agent="codex"]').getByText('Signed in', { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), 'fake-unsaved-key-draft');
    assert.equal(await draft.evaluate((input: HTMLInputElement) => document.activeElement === input), true);
    await claude.getByText('Signed out', { exact: true }).waitFor({ timeout: 6500 });
    assert.equal(
      await claude.getByText('Connected to Claude Code', { exact: true }).count(),
      0,
      'fresh failed account checks must retire optimistic completion',
    );
    claudeSignedInOverride = undefined;
    // Reload must resume a waiting device flow using GET only, never another login.
    states.codex = { state: 'waiting', url: 'https://auth.example.test/device', code: 'ABCD-EFGH' };
    codexSignedIn = false;
    delayedPolls = true;
    maxConcurrentPolls = 0;
    await page.reload();
    const codex = page.locator('[data-agent="codex"]');
    await codex.getByText('ABCD-EFGH', { exact: true }).waitFor();
    assert.equal(starts.filter((value: any) => value.name === 'codex').length, 0);
    assert.equal(await codex.locator('input').count(), 0, 'device-code flows must not ask for a pasted Claude code');
    const beforeFocus = polls.codex;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const focusDeadline = Date.now() + 300;
    while (polls.codex === beforeFocus && Date.now() < focusDeadline) await page.waitForTimeout(10);
    assert.equal(polls.codex, beforeFocus! + 1, 'returning to the home must immediately check its active flow');
    await codex.getByRole('button', { name: 'Copy code', exact: true }).click();
    await codex.getByText('Code copied', { exact: true }).waitFor();
    await page.waitForTimeout(1800);
    assert.equal(maxConcurrentPolls, 1, 'a slow login GET must not overlap the next poll');
    await codex.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await codex.getByText('Sign-in cancelled', { exact: true }).waitFor();
    const afterCancel = polls.codex;
    await page.waitForTimeout(900);
    assert.equal(polls.codex, afterCancel, 'cancelled flows must stop polling');
    delayedPolls = false;
    failCode = true;
    await claude.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByLabel('Claude confirmation code').fill('fake-invalid-code');
    await claude.getByRole('button', { name: 'Confirm code', exact: true }).click();
    await claude.getByText('Sign-in did not finish', { exact: true }).waitFor();
    await claude.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByLabel('Claude confirmation code').waitFor();
    assert.equal(await claude.getByRole('button', { name: 'Confirm code', exact: true }).isEnabled(), true);
    if (process.env.RUNNER_SIGNIN_SCREENSHOT)
      await page.screenshot({ path: process.env.RUNNER_SIGNIN_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('header').count(), 1);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'guided sign-in must fit a narrow viewport',
    );
    if (process.env.RUNNER_SIGNIN_SCREENSHOT)
      await page.screenshot({
        path: process.env.RUNNER_SIGNIN_SCREENSHOT.replace(/\.png$/, '-mobile.png'),
        fullPage: false,
      });
    assert.deepEqual(errors, []);
  },
);

test(
  'status refresh recovery clears only its own notice and preserves owner drafts and copy feedback',
  {
    skip: !browserPath && 'No Chrome/Chromium installed',
    timeout: 15_000,
  },
  async (t) => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true, executablePath: browserPath });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    await page.addInitScript(() => {
      const interval = window.setInterval.bind(window);
      window.setInterval = ((callback: TimerHandler, delay?: number, ...args: any[]) =>
        interval(callback, delay === 5000 ? 100 : delay, ...args)) as typeof window.setInterval;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    });
    const files = new Map(
      await Promise.all(
        [
          ['/', '../src/ui/web/index.html'],
          ['/assets/home.js', '../src/ui/web/home.js'],
          ['/assets/fleet.js', '../src/ui/web/fleet.js'],
          ['/assets/extensions.js', '../src/ui/web/extensions.js'],
          ['/assets/home.css', '../src/ui/web/home.css'],
        ].map(async ([url, file]) => [url!, await readFile(new URL(file!, import.meta.url), 'utf8')] as const),
      ),
    );
    let responseStatus = 503;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const reply = (value: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (files.has(path))
        return route.fulfill({
          contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
          body: files.get(path),
        });
      if (path === '/status')
        return responseStatus === 200
          ? reply({ clis: [], limited: {}, features: { orchestrator: false, extensions: false } })
          : reply({ error: 'fixture unavailable' }, responseStatus);
      if (path === '/keys')
        return reply({
          providers: [{ id: 'openrouter', name: 'OpenRouter', set: false, billing: 'use', harnesses: ['claude'] }],
          profiles: [],
        });
      if (path === '/usage') return reply({ clis: [] });
      if (path === '/link') return reply({ query: '?session=synthetic-copy-fixture' });
      return reply({ error: 'unexpected fixture route' }, 404);
    });
    await page.goto('http://recovery.test/');
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await page
      .locator('#notice')
      .getByText('Home status is temporarily unavailable. Retrying…', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('#notice')
        .getByText('Open this home with its private link to connect.', { exact: true })
        .count(),
      0,
      '503 is not an authentication failure',
    );
    responseStatus = 200;
    const draft = page.getByLabel('OpenRouter key');
    await draft.waitFor();
    await page.waitForFunction(() => document.getElementById('notice')?.textContent === '');
    await draft.fill('synthetic-unsaved-draft');
    responseStatus = 503;
    await page
      .locator('#notice')
      .getByText('Home status is temporarily unavailable. Retrying…', { exact: true })
      .waitFor();
    responseStatus = 200;
    await page.waitForFunction(() => document.getElementById('notice')?.textContent === '');
    assert.equal(await draft.inputValue(), 'synthetic-unsaved-draft');
    responseStatus = 401;
    await page
      .locator('#notice')
      .getByText('Open this home with its private link to connect.', { exact: true })
      .waitFor();
    responseStatus = 200;
    await page.waitForFunction(() => document.getElementById('notice')?.textContent === '');
    await page.getByRole('button', { name: 'Copy private home link', exact: true }).click();
    await page.locator('#notice').getByText('Link copied', { exact: true }).waitFor();
    responseStatus = 503;
    await page.waitForTimeout(250);
    responseStatus = 200;
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator('#notice').textContent(),
      'Link copied',
      'refresh failure and recovery must preserve unrelated owner feedback',
    );
    assert.equal(await draft.inputValue(), 'synthetic-unsaved-draft');
  },
);
