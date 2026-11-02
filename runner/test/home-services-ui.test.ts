import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const browserPath = process.env.RUNNER_CHROME_BIN ?? ['/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);

test('home service controls require explicit launch, pairing and paid routing consent', { skip: !browserPath, timeout: 20_000 }, async (t) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const mutations: string[] = [];
  const state = { t3: { installed: true, state: 'stopped', publicUrl: 'https://t3.example.test', optinOpenRouter: false } };
  const ids = ['t3-status', 't3-notice', 'dsh-service', 'briq-status', 'briq-login-code'];
  const buttons = ['t3-start', 't3-pair', 'services-refresh', 'briq-check', 'briq-login'];
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body:
      ids.map((id) => `<p id="${id}"></p>`).join('') + buttons.map((id) => `<button id="${id}">${id}</button>`).join('') +
      '<input type="checkbox" id="t3-openrouter"><a id="t3-open" hidden>Open T3 Code</a><a id="briq-login-open" hidden>Approve Briq sign-in</a>' +
      '<script type="module">import{createHomeServices}from"/services.js";createHomeServices({byId:id=>document.getElementById(id),call:async(method,path,body)=>{const r=await fetch(path,{method,headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined});return{ok:r.ok,body:await r.json()}}});</script>' });
    if (path === '/services.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../src/ui/web/services.js', import.meta.url), 'utf8') });
    const method = route.request().method();
    if (method !== 'GET') mutations.push(method + ' ' + path);
    if (path === '/home-services/t3') state.t3.state = 'running';
    if (path === '/home-services/t3/routing') state.t3.optinOpenRouter = route.request().postDataJSON().optinOpenRouter;
    const body = path.endsWith('/pair') ? { url: 'https://t3.example.test/pair#token=test-private-pair', expiresAt: new Date(Date.now() + 300000).toISOString() } :
      path.endsWith('/briq') ? { authenticated: true, login: { state: 'idle' } } : state;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://home-service.test/');
  await page.getByText('T3 Code is stopped.', { exact: true }).waitFor();
  assert.deepEqual(mutations, []);
  assert.equal(await page.locator('#t3-pair').isDisabled(), true);
  await page.locator('#t3-start').click();
  await page.getByText(/T3 Code process is running/).waitFor();
  await page.locator('#t3-openrouter').check();
  assert.equal(state.t3.optinOpenRouter, true);
  await page.locator('#t3-pair').click();
  await page.locator('#t3-open:visible').waitFor();
  assert.equal(await page.locator('#t3-open').getAttribute('href'), 'https://t3.example.test/pair#token=test-private-pair');
  await page.locator('#briq-check').click();
  await page.getByText('Briq CLI is connected.', { exact: true }).waitFor();
  assert.deepEqual(mutations, ['POST /home-services/t3', 'PUT /home-services/t3/routing', 'POST /home-services/t3/pair']);
});
