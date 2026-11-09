import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const browserPath = process.env.RUNNER_CHROME_BIN ?? ['/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);

test('home service controls check native Briq status and require explicit sign-in', { skip: !browserPath, timeout: 20_000 }, async (t) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const mutations: string[] = [];
  let authenticated = false;
  let login = { state: 'idle', url: '', code: '' };
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body:
      ['dsh-service', 'briq-status', 'briq-login-code'].map((id) => `<p id="${id}"></p>`).join('') +
      '<button id="briq-check">Check connection</button><button id="briq-login">Sign in</button><a id="briq-login-open" hidden>Approve Briq sign-in</a>' +
      '<script type="module">import{createHomeServices}from"/services.js";createHomeServices({byId:id=>document.getElementById(id),call:async(method,path,body)=>{const r=await fetch(path,{method,headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined});return{ok:r.ok,body:await r.json()}}});</script>' });
    if (path === '/services.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../src/ui/web/services.js', import.meta.url), 'utf8') });
    const method = route.request().method();
    if (method !== 'GET') mutations.push(method + ' ' + path);
    if (path.endsWith('/login')) login = { state: 'waiting', url: 'https://briq.example.test/approve', code: 'ABCD-EFGH' };
    const body = path.endsWith('/login') ? login : path.endsWith('/briq') ? { authenticated, login } :
      { dsh: { installed: true, enabled: false } };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://home-service.test/');
  await page.getByText('DSH is installed.', { exact: false }).waitFor();
  assert.deepEqual(mutations, []);
  await page.locator('#briq-check').click();
  await page.getByText('Briq CLI is signed out.', { exact: true }).waitFor();
  await page.locator('#briq-login').click();
  await page.locator('#briq-login-open:visible').waitFor();
  assert.equal(await page.locator('#briq-login-open').getAttribute('href'), 'https://briq.example.test/approve');
  await page.getByText('Approve only if Briq shows code ABCD-EFGH.', { exact: true }).waitFor();
  assert.deepEqual(mutations, ['POST /home-services/briq/login']);
  assert.equal(await page.locator('#briq-login').isDisabled(), true);
  authenticated = true;
  login = { state: 'done', url: '', code: '' };
  await page.locator('#briq-check').click();
  await page.getByText('Briq CLI is connected.', { exact: true }).waitFor();
  assert.equal(await page.locator('#briq-login-open').isHidden(), true);
  assert.equal(await page.locator('#briq-login-open').getAttribute('href'), null);
});
