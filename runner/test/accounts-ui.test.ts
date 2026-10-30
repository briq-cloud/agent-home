import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
const browserPath =
  process.env.RUNNER_CHROME_BIN ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
    (path) => existsSync(path),
  );
test(
  'named Claude accounts reuse isolated sign-in UI and enablement controls only Auto selection',
  {
    skip: !browserPath && 'No Chrome installed',
    timeout: 20_000,
  },
  async (t) => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true, executablePath: browserPath });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.setDefaultTimeout(4000);
    await page.addInitScript(() => {
      const interval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, delay?: number, ...args: any[]) =>
        interval(handler, delay === 5000 ? 100 : delay, ...args)) as typeof window.setInterval;
    });
    const files = new Map(
      await Promise.all(
        [
          ['/', 'index.html'],
          ['/assets/home.js', 'home.js'],
          ['/assets/fleet.js', 'fleet.js'],
          ['/assets/extensions.js', 'extensions.js'],
          ['/assets/home.css', 'home.css'],
        ].map(
          async ([url, file]) =>
            [url!, await readFile(new URL('../src/ui/web/' + file, import.meta.url), 'utf8')] as const,
        ),
      ),
    );
    const accounts: any[] = [
      {
        id: 'default',
        cli: 'claude',
        harness: 'claude',
        label: 'Claude Code',
        enabled: true,
        priority: 0,
        isDefault: true,
      },
    ];
    const signIns: Record<string, any> = {};
    const mutations: Array<{ method: string; path: string; body: any }> = [];
    let rejectAdd = true,
      holdNextStatus = false,
      statusHeld = false,
      holdFreshStatus = false;
    let releaseStatus: (() => void) | undefined;
    const releaseFresh: Array<() => void> = [];
    t.after(() => {
      releaseStatus?.();
      for (const release of releaseFresh) release();
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      const reply = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (files.has(path))
        return route.fulfill({
          contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
          body: files.get(path),
        });
      if (path.startsWith('/assets/icons/'))
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
      if (path === '/status') {
        const snapshot = {
          clis: accounts.map((account) => ({
            name: account.cli,
            subscriptionAccount: { ...account },
            billing: account.isDefault ? 'use' : signIns[account.cli]?.state === 'done' ? 'subscription' : 'unknown',
            signInWith: 'page',
            statusSource: 'sdk',
            signedIn: signIns[account.cli]?.state === 'done',
            signIn: signIns[account.cli]?.state || 'idle',
          })),
          features: { orchestrator: true, extensions: false },
          limited: {},
        };
        if (holdNextStatus) {
          holdNextStatus = false;
          statusHeld = true;
          await new Promise<void>((resolve) => {
            releaseStatus = resolve;
          });
        } else if (holdFreshStatus) await new Promise<void>((resolve) => releaseFresh.push(resolve));
        return reply(snapshot);
      }
      if (path === '/accounts' && req.method() === 'GET') return reply({ accounts });
      if (path === '/accounts' && req.method() === 'POST') {
        const body = req.postDataJSON();
        mutations.push({ method: req.method(), path, body });
        if (rejectAdd) {
          rejectAdd = false;
          return reply({ error: 'Account could not be added. Try again.' }, 409);
        }
        const account = {
          id: 'work',
          cli: 'claude-account-work',
          harness: 'claude',
          label: body.label,
          enabled: true,
          priority: 10,
          isDefault: false,
        };
        accounts.push(account);
        return reply({ account }, 201);
      }
      if (path === '/accounts/work' && req.method() === 'PATCH') {
        const body = req.postDataJSON();
        mutations.push({ method: req.method(), path, body });
        Object.assign(accounts[1], body);
        return reply({ account: accounts[1] });
      }
      if (path.startsWith('/connect/')) {
        const alias = path.split('/')[2]!;
        assert.equal(alias, 'claude-account-work');
        if (req.method() === 'POST') {
          const body = req.postDataJSON();
          mutations.push({ method: req.method(), path, body });
          signIns[alias] = path.endsWith('/input')
            ? { state: 'done' }
            : { state: 'waiting', url: 'https://auth.example/authorize', code: 'NOT-A-DEVICE-CODE' };
        }
        return reply(signIns[alias] || { state: 'idle' });
      }
      if (path === '/keys')
        return reply({
          providers: [{ id: 'openrouter', name: 'OpenRouter', set: false, billing: 'use', harnesses: ['claude'] }],
          profiles: [],
        });
      if (path === '/usage') return reply({ clis: [] });
      if (path === '/features')
        return reply({ orchestrator: true, concurrency: { coordinators: 1, children: 1, maxDepth: 1 } });
      if (path === '/projects') return reply({ projects: [{ id: 'home' }] });
      if (path === '/tasks') return reply({ tasks: [], nextOffset: null });
      return reply({ error: 'unexpected fixture route' }, 404);
    });
    await page.goto('http://accounts.test/');
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await page.locator('[data-agent="claude"]').waitFor();
    await page.locator('[data-agent="claude"]').getByText('Claude Code · API key', { exact: true }).waitFor();
    assert.equal(
      await page.locator('[data-agent="claude"]').getByText('Claude Code · Subscription', { exact: true }).count(),
      0,
      'default API-key authentication must not be called a subscription',
    );
    // Navigation keeps the same mounted form/session state and supports keyboard tabs.
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Keep this chat draft');
    await page.getByRole('tab', { name: 'Chat', exact: true }).press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Fleet', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel-chat').isVisible(), false);
    await page.getByRole('tab', { name: 'Fleet', exact: true }).press('End');
    assert.equal(await page.getByRole('tab', { name: 'Tools', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'Keep this chat draft');
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await page.getByText('Add a Claude subscription account', { exact: true }).click();
    const label = 'Work <img src=x onerror=window.compromised=true>';
    await page.getByLabel('Claude account label').fill(label);
    await page.getByLabel('OpenRouter key').fill('keep-owner-key-draft');
    await page.getByRole('button', { name: 'Add Claude account', exact: true }).click();
    await page.getByText('Account could not be added. Try again.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Claude account label').inputValue(), label);
    await page.getByRole('button', { name: 'Add Claude account', exact: true }).click();
    const card = page.locator('[data-agent="claude-account-work"]');
    await card.getByText(label, { exact: true }).waitFor();
    await card.getByText('Claude Code · Account', { exact: true }).waitFor();
    assert.equal(
      await card.getByText('Claude Code · Subscription', { exact: true }).count(),
      0,
      'new account has no proven subscription until native confirmation',
    );
    assert.deepEqual(mutations[1], { method: 'POST', path: '/accounts', body: { harness: 'claude', label } });
    assert.equal(
      mutations.some((value) => value.path.startsWith('/connect/')),
      false,
      'adding account must not start authentication',
    );
    assert.match((await card.locator('img').getAttribute('src')) || '', /claude\.svg$/);
    assert.equal(await page.evaluate(() => (window as any).compromised), undefined);
    assert.equal(await page.getByLabel('OpenRouter key').inputValue(), 'keep-owner-key-draft');
    await page.getByLabel('Claude account label').fill('Keep another account draft');
    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    await card.getByRole('link', { name: 'Open Claude Code sign-in ↗', exact: true }).waitFor();
    await card.getByLabel('Claude confirmation code').waitFor();
    assert.equal(
      await card.getByText('NOT-A-DEVICE-CODE', { exact: true }).count(),
      0,
      'Claude aliases use pasted confirmation, not device-code display',
    );
    assert.deepEqual(mutations.at(-1), { method: 'POST', path: '/connect/claude-account-work', body: { wait: false } });
    await card.getByLabel('Claude confirmation code').fill('synthetic-account-code');
    await card.getByRole('button', { name: 'Confirm code', exact: true }).click();
    await card.getByText('Signed in', { exact: true }).first().waitFor();
    assert.deepEqual(mutations.at(-1), {
      method: 'POST',
      path: '/connect/claude-account-work/input',
      body: { text: 'synthetic-account-code' },
    });
    holdNextStatus = true;
    const holdDeadline = Date.now() + 2000;
    while (!statusHeld && Date.now() < holdDeadline) await page.waitForTimeout(10);
    assert.equal(statusHeld, true);
    await card.getByRole('button', { name: 'Exclude from Auto', exact: true }).click();
    await card.getByText('Excluded from new Auto tasks', { exact: true }).waitFor();
    assert.deepEqual(mutations.at(-1), { method: 'PATCH', path: '/accounts/work', body: { enabled: false } });
    holdFreshStatus = true;
    const staleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/status');
    releaseStatus?.();
    await staleResponse;
    await page.waitForTimeout(50);
    assert.equal(
      await card.getByText('Excluded from new Auto tasks', { exact: true }).count(),
      1,
      'a status response begun before PATCH must not undo acknowledged selection',
    );
    holdFreshStatus = false;
    for (const release of releaseFresh) release();
    assert.equal(
      await card.getByRole('button', { name: 'Chat →', exact: true }).count(),
      1,
      'excluded accounts remain explicitly selectable',
    );
    await card.getByRole('button', { name: 'Include in Auto', exact: true }).click();
    await card.getByText('Included in Auto', { exact: true }).waitFor();
    assert.deepEqual(mutations.at(-1)?.body, { enabled: true });
    await page.waitForTimeout(250);
    assert.equal(await page.getByLabel('Claude account label').inputValue(), 'Keep another account draft');
    assert.equal(await page.getByLabel('OpenRouter key').inputValue(), 'keep-owner-key-draft');
    assert.equal(
      await page
        .locator('#chat-agent option')
        .filter({ hasText: label + ' · Claude Code' })
        .count(),
      1,
    );
    await page.getByRole('tab', { name: 'Fleet', exact: true }).click();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    assert.equal(await page.getByLabel('Claude account label').inputValue(), 'Keep another account draft');
    assert.equal(await page.getByLabel('OpenRouter key').inputValue(), 'keep-owner-key-draft');
    accounts[1].label = 'Q'.repeat(80);
    await card.getByText('Q'.repeat(80), { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto('http://accounts.test/#keys-section');
    assert.equal(await page.getByRole('tab', { name: 'Connections', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByLabel('OpenRouter key').waitFor({ state: 'visible' });
    await page.getByRole('tab', { name: 'Tools', exact: true }).click();
    await page.goto('http://accounts.test/');
    assert.equal(await page.getByRole('tab', { name: 'Tools', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.goBack();
    assert.equal(await page.getByRole('tab', { name: 'Tools', exact: true }).getAttribute('aria-selected'), 'true');
    assert.deepEqual(errors, []);
  },
);
