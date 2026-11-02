import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
      '<input type="checkbox" id="t3-openrouter"><a id="t3-open" hidden>Open T3 Code</a><a id="t3-pair-open" hidden>Pair this browser</a><a id="briq-login-open" hidden>Approve Briq sign-in</a>' +
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
  assert.equal(await page.locator('#t3-open').getAttribute('href'), '/api/services/t3/open');
  await page.locator('#t3-pair-open:visible').waitFor();
  assert.equal(await page.locator('#t3-pair-open').getAttribute('href'), 'https://t3.example.test/pair#token=test-private-pair');
  await page.locator('#briq-check').click();
  await page.getByText('Briq CLI is connected.', { exact: true }).waitFor();
  assert.deepEqual(mutations, ['POST /home-services/t3', 'PUT /home-services/t3/routing', 'POST /home-services/t3/pair']);
});

test('fresh browsers pass the private T3 gateway and preserve the native pairing fragment', { skip: !browserPath, timeout: 20_000 }, async (t) => {
  // Use real loopback HTTP responses: intercepted redirects can escape page.route and
  // attempt DNS. Chromium treats localhost as secure for this Secure cookie fixture.
  const gateway = 'fake-browser-gateway-capability';
  let port = 0;
  let firstRequestHadCookie: boolean | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.hostname === '127.0.0.1') {
      response.writeHead(302, { location: `http://localhost:${port}/?briq_token=${gateway}`,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return;
    }
    const cookie = request.headers.cookie ?? '';
    firstRequestHadCookie ??= cookie.includes('briq_token=');
    if (url.searchParams.get('briq_token') === gateway) {
      response.writeHead(302, { location: url.pathname,
        'set-cookie': `briq_token=${gateway}; Path=/; HttpOnly; Secure; SameSite=Lax` });
      response.end();
      return;
    }
    if (!cookie.includes('briq_token=' + gateway)) {
      response.writeHead(401); response.end('unauthorized'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<p>Mock T3 reached</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  t.after(() => browser.close());
  for (const pair of [false, true]) {
    const context = await browser.newContext();
    try {
      assert.equal((await context.cookies()).length, 0);
      firstRequestHadCookie = undefined;
      const page = await context.newPage();
      const target = pair ? `http://localhost:${port}/pair?briq_token=${gateway}#token=fake-one-use-pair` :
        `http://127.0.0.1:${port}/api/services/t3/open`;
      const response = await page.goto(target);
      assert.equal(response!.status(), 200);
      assert.equal(firstRequestHadCookie, false);
      assert.equal(new URL(page.url()).search, '');
      assert.equal(new URL(page.url()).hash, pair ? '#token=fake-one-use-pair' : '');
      const cookies = await context.cookies(`http://localhost:${port}`);
      assert.equal(cookies.length, 1);
      assert.equal(cookies[0]!.domain, 'localhost');
      assert.equal(cookies[0]!.httpOnly, true);
      assert.equal(cookies[0]!.secure, true);
      assert.equal((await context.cookies(`http://127.0.0.1:${port}`)).length, 0);
    } finally { await context.close(); }
  }
});
