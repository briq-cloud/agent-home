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
  'owner extensions UI preserves drafts, validates refs, and scopes explicit configuration actions',
  { skip: !browserPath && 'No Chrome installed', timeout: 25_000 },
  async (t) => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true, executablePath: browserPath });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(4000);
    const js = await readFile(new URL('../src/ui/web/extensions.js', import.meta.url), 'utf8'),
      css = await readFile(new URL('../src/ui/web/home.css', import.meta.url), 'utf8');
    const state = {
      version: 1,
      revision: 'fixture',
      servers: [
        {
          name: 'briq',
          transport: 'http',
          url: 'https://api.example/mcp',
          enabled: true,
          required: false,
          headerEnvRefs: { Authorization: { env: 'BRIQ_MCP_TOKEN', prefix: 'Bearer ' } },
        },
        {
          name: '<img src=x onerror=window.compromised=true>',
          transport: 'stdio',
          command: '/installed/tool',
          enabled: true,
          envRefs: {},
        },
      ],
      skills: [
        {
          name: 'home-briq',
          description: 'Inspect <img src=x onerror=window.compromised=true> safely',
          hash: 'a'.repeat(64),
        },
      ],
      agents: [
        { cli: 'claude', harness: 'claude', initialized: false, statuses: [{ name: 'briq', status: 'auth_required' }] },
        {
          cli: 'cursor',
          harness: 'cursor',
          initialized: false,
          statuses: [{ name: 'briq', status: 'unverified', reason: 'Session injection unverified' }],
        },
      ],
    };
    const mutations: Array<{ method: string; path: string; body: any }> = [];
    let reads = 0,
      rejectSave = true;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/home.css"><main><section id="extensions"></section></main><script type="module">import{createExtensions}from'/extensions.js';window.enabled=false;window.view=createExtensions({root:document.getElementById('extensions'),getFeatures:()=>({extensions:window.enabled}),request:async(method,path,body)=>{const r=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return{ok:r.ok,body:await r.json()}}});await window.view.refresh();window.initialized=true;</script>`,
        });
      if (path === '/extensions.js') return route.fulfill({ contentType: 'text/javascript', body: js });
      if (path === '/home.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (path === '/extensions' && req.method() === 'GET') {
        reads++;
        return respond(state);
      }
      if (path.startsWith('/extensions/')) {
        const body = req.postData() ? req.postDataJSON() : undefined;
        mutations.push({ method: req.method(), path, body });
        if (req.method() === 'PUT' && path.includes('/mcp/') && rejectSave) {
          rejectSave = false;
          return respond({ error: 'invalid_extension_configuration' }, 400);
        }
        if (req.method() === 'DELETE')
          return respond({
            revision: 'next',
            userFilesPreserved: true,
            links: [{ name: 'home-briq', status: 'conflict' }],
          });
        return respond({ revision: 'next' });
      }
      return respond({ error: 'unexpected fixture route' }, 404);
    });
    await page.goto('http://extensions.test/');
    await page.waitForFunction(() => (window as any).initialized);
    assert.equal(reads, 0);
    assert.equal(await page.locator('#extensions').isVisible(), false);
    await page.evaluate(async () => {
      (window as any).enabled = true;
      await (window as any).view.refresh();
    });
    await page.getByText('Skills and MCP tools', { exact: true }).click();
    await page.getByText('claude · Authorization required', { exact: true }).waitFor();
    await page.getByText('cursor · Delivery unverified · Session injection unverified', { exact: true }).waitFor();
    assert.equal(mutations.length, 0);
    await page.getByText('<img src=x onerror=window.compromised=true>', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).compromised), undefined);
    await page.getByText('Add or update a skill', { exact: true }).click();
    await page.getByLabel('Shared skill name').fill('home-team');
    await page.getByLabel('Shared skill description').fill('Team workflow');
    await page.getByLabel('Shared skill instructions').fill('Keep this trusted draft.');
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    assert.equal(await page.getByLabel('Shared skill instructions').inputValue(), 'Keep this trusted draft.');
    await page.getByRole('button', { name: 'Save skill', exact: true }).click();
    await page.getByText('Skill saved. It applies at the next native session open or load.', { exact: true }).waitFor();
    assert.deepEqual(mutations[0], {
      method: 'PUT',
      path: '/extensions/skills/home-team',
      body: { name: 'home-team', description: 'Team workflow', body: 'Keep this trusted draft.' },
    });
    await page.getByText('Add or update an MCP connection', { exact: true }).click();
    await page.getByLabel('MCP connection name').fill('docs');
    await page.getByLabel('MCP server URL').fill('https://docs.example/mcp');
    await page.getByText('Credential references (advanced)', { exact: true }).click();
    await page.getByLabel('MCP credential environment references JSON').fill('{broken');
    await page.getByRole('button', { name: 'Save MCP connection', exact: true }).click();
    await page.getByText('Credential references must be valid JSON.', { exact: true }).waitFor();
    assert.equal(mutations.length, 1, 'invalid JSON must not make a mutation request');
    await page.getByLabel('MCP credential environment references JSON').fill('{"Authorization":"actual-secret"}');
    await page.getByRole('button', { name: 'Save MCP connection', exact: true }).click();
    await page.getByText(/Never paste a credential value here/).waitFor();
    assert.equal(mutations.length, 1);
    await page
      .getByLabel('MCP credential environment references JSON')
      .fill('{"Authorization":{"env":"DOCS_TOKEN","prefix":"Bearer "}}');
    await page.getByRole('button', { name: 'Save MCP connection', exact: true }).click();
    await page.getByText(/Configuration rejected/).waitFor();
    assert.equal(await page.getByLabel('MCP server URL').inputValue(), 'https://docs.example/mcp');
    await page.getByRole('button', { name: 'Save MCP connection', exact: true }).click();
    await page.getByText(/MCP connection saved/).waitFor();
    assert.deepEqual(mutations.at(-1)?.body, {
      name: 'docs',
      transport: 'http',
      url: 'https://docs.example/mcp',
      headerEnvRefs: { Authorization: { env: 'DOCS_TOKEN', prefix: 'Bearer ' } },
      enabled: true,
      required: false,
    });
    await page.getByLabel('MCP transport').selectOption('stdio');
    await page.getByLabel('MCP connection name').fill('local');
    await page.getByLabel('Installed MCP command').fill('/usr/local/bin/local-mcp');
    await page.getByLabel('MCP command arguments').fill('--stdio\n--project\n/work/my project');
    await page.getByLabel('MCP credential environment references JSON').fill('{"CHILD_TOKEN":"OWNER_TOKEN"}');
    await page.getByRole('button', { name: 'Save MCP connection', exact: true }).click();
    await page.getByText(/MCP connection saved/).waitFor();
    assert.deepEqual(mutations.at(-1)?.body, {
      name: 'local',
      transport: 'stdio',
      command: '/usr/local/bin/local-mcp',
      args: ['--stdio', '--project', '/work/my project'],
      envRefs: { CHILD_TOKEN: 'OWNER_TOKEN' },
      enabled: true,
      required: false,
    });
    await page.getByRole('button', { name: 'Delete skill home-briq', exact: true }).click();
    await page.getByText(/discovery-link conflicts: home-briq/).waitFor();
    assert.equal(mutations.at(-1)?.method, 'DELETE');
    assert.equal(mutations.at(-1)?.path, '/extensions/skills/home-briq');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    const priorReads = reads;
    await page.evaluate(async () => {
      (window as any).enabled = false;
      await (window as any).view.refresh();
    });
    assert.equal(await page.locator('#extensions').isVisible(), false);
    assert.equal(reads, priorReads);
  },
);
