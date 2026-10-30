import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browserPath = process.env.RUNNER_CHROME_BIN ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path => existsSync(path));
test('Fleet displays hierarchy, routes, messages and explicit scoped actions through existing APIs', {
  skip: !browserPath && 'No Chrome/Chromium binary installed', timeout: 25_000,
}, async t => {
  const { chromium } = await import('playwright-core');
  let releaseArtifact: (() => void) | undefined;
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  t.after(() => { releaseArtifact?.(); return browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1220, height: 1000 } });
  page.setDefaultTimeout(4000);
  const js = await readFile(fileURLToPath(new URL('../src/ui/web/fleet.js', import.meta.url)), 'utf8');
  const css = await readFile(fileURLToPath(new URL('../src/ui/web/home.css', import.meta.url)), 'utf8');
  const base = { projectId: 'home', parentId: null, dependencyIds: [], route: { mode: 'auto' }, attempts: 1,
    maxAttempts: 2, runtimeMs: 1000, costMicros: null, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
    deadline: null, failureReason: null, sessionRef: null, outputRef: null, errorRef: null, permissionRef: null };
  const tasks: Record<string, any> = {
    root: { ...base, id: 'root', status: 'running', promptRef: 'root-prompt', sessionRef: 'root-session' },
    child: { ...base, id: 'child', parentId: 'root', dependencyIds: ['failed'], status: 'running', promptRef: 'child-prompt', sessionRef: 'child-session', permissionRef: 'pending' },
    failed: { ...base, id: 'failed', status: 'failed', promptRef: 'failed-prompt', errorRef: 'failed-error', failureReason: 'acceptance_failed' },
    verified: { ...base, id: 'verified', status: 'succeeded', promptRef: 'verified-prompt', outputRef: 'verified-output' },
    late: { ...base, id: 'late', status: 'queued', promptRef: 'late-prompt' },
    other: { ...base, id: 'other', projectId: 'other-project', status: 'queued', promptRef: 'other-prompt' },
  };
  const fillers = Array.from({ length: 96 }, (_, index) => ({ ...base, id: 'history-' + index, status: 'succeeded', promptRef: 'empty' }));
  const firstIds = ['root', 'child', 'failed', 'verified'];
  const artifacts: Record<string, any> = {
    'root-session': { cli: 'mock', route: { cli: 'mock', model: 'provider/root-model', source: 'subscription' } },
    'child-session': { cli: 'openrouter-claude-haiku', route: { cli: 'openrouter-claude-haiku', model: 'provider/child-model', source: 'decision' } },
    'root-prompt': { submission: { prompt: 'Coordinate a project' } },
    'child-prompt': { submission: { prompt: 'Inspect <img src=x onerror="window.compromised=true"> safely' } },
    'failed-prompt': { submission: { prompt: 'A failed prerequisite' } }, 'verified-prompt': { submission: { prompt: 'Verified work' } },
    'failed-error': { message: 'Acceptance command failed' },
    'verified-output': { text: 'Delivered result', verification: { status: 'passed', checks: [{ kind: 'command', argv: ['node', '--test'], status: 'passed', stdout: 'all passed' }] } },
  };
  const inbox = Array.from({ length: 51 }, (_, index) => ({ id: 'message-' + index, sender: 'root', recipient: 'child',
    text: index === 0 ? 'Remember <script>window.compromised=true</script>' : 'Message ' + index, createdAt: base.createdAt + index, acknowledgedAt: null }));
  const mutations: { path: string; body: any }[] = [];
  let permissionPending = true, rejectPermission = true, draining = false, holdVerified = false;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/home.css"><main><h2 id="tasks-title">Tasks</h2><div id="task-list"></div></main><script type="module">import{createFleet}from'/assets/fleet.js';const request=async(method,path,body)=>{const r=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return{ok:r.ok,body:await r.json()}};window.fleet=createFleet({root:document.getElementById('task-list'),request,getAgents:()=>[{name:'mock',signedIn:true},{name:'openrouter-claude-haiku',signedIn:true,profile:{model:'provider/child-model'}}],getFeatures:()=>({orchestrator:true})});window.fleet.refresh();</script>` });
    if (path === '/assets/fleet.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (path === '/assets/home.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (path === '/projects') return respond({ projects: [{ id: 'home' }, { id: 'other-project' }] });
    if (path === '/features') return respond({ orchestrator: true, delegation: true,
      concurrency: { coordinators: 2, children: 2, maxDepth: 1 }, fleet: { occupiedSlots: 1, totalSlots: 4,
        draining: draining ? [{ taskId: 'root', projectId: 'home' }] : [] } });
    if (path === '/tasks' && method === 'GET') {
      if (url.searchParams.get('projectId') === 'other-project') return respond({ tasks: [tasks.other], nextOffset: null });
      const offset = Number(url.searchParams.get('offset') || 0);
      return respond(offset === 0 ? { tasks: firstIds.map(id => tasks[id]).concat(fillers), nextOffset: 100 } : { tasks: [tasks.late], nextOffset: null });
    }
    if (path === '/tasks' && method === 'POST') {
      const body = route.request().postDataJSON(); mutations.push({ path, body });
      const task = { ...base, ...body, status: 'queued', attempts: 0, promptRef: 'created-prompt' }; tasks[body.id] = task;
      artifacts['created-prompt'] = { submission: { prompt: body.prompt } }; return respond({ task }, 202);
    }
    if (path.startsWith('/tasks/')) {
      const [, , id, action, requestId] = path.split('/'); const task = tasks[id!];
      if (!task) return respond({ error: 'unknown task' }, 404);
      if (method === 'POST') {
        const body = route.request().postData() ? route.request().postDataJSON() : undefined;
        mutations.push({ path, body });
        if (action === 'permissions') {
          assert.equal(requestId, 'permission-1'); assert.equal(body.optionId, 'allow');
          if (rejectPermission) { rejectPermission = false; return respond({ error: 'Permission expired; refresh and retry' }, 409); }
          permissionPending = false; task.permissionRef = null; return respond({ taskId: id });
        }
        if (action === 'cancel') { task.status = 'cancelled'; task.updatedAt++; draining = true; tasks.child.status = 'cancelled'; return respond(task); }
        if (action === 'retry') { task.status = 'queued'; task.updatedAt++; return respond(task, 202); }
      }
      if (action === 'permissions') return respond({ permissions: permissionPending ? [{ requestId: 'permission-1', params: {
        toolCall: { title: 'Write configuration' }, options: [{ name: 'Allow once', optionId: 'allow' }] } }] : [] });
      return respond(task);
    }
    if (path.startsWith('/artifacts/')) {
      const ref = path.split('/').at(-1)!;
      if (ref === 'verified-output' && holdVerified) await new Promise<void>(resolve => { releaseArtifact = resolve; });
      return respond({ content: JSON.stringify(artifacts[ref] || { submission: { prompt: 'Task instruction' } }) });
    }
    if (path === '/messages' && method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0), recipient = url.searchParams.get('recipient');
      const rows = recipient === 'child' ? inbox : [];
      return respond({ messages: rows.slice(offset, offset + 50), nextOffset: offset + 50 < rows.length ? offset + 50 : null });
    }
    if (path === '/messages' && method === 'POST') {
      const body = route.request().postDataJSON(); mutations.push({ path, body });
      inbox.push({ ...body, id: 'new-message', sender: 'user', createdAt: base.createdAt + 100, acknowledgedAt: null }); return respond({ id: 'new-message' }, 201);
    }
    return respond({ error: 'unexpected mocked route ' + path }, 404);
  });
  await page.goto('http://fleet.test/');
  await page.getByRole('button', { name: 'Load more tasks', exact: true }).waitFor();
  assert.equal(mutations.length, 0, 'opening the inspector must not start work or answer permissions');
  await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
  await page.locator('[data-task-id="late"]').waitFor();
  await page.locator('[data-task-id="child"]').click();
  await page.getByText('provider/child-model', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Depends on · failed', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Parent · root', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByText('Permission expired; refresh and retry', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Allow once', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByText('Permission response accepted.', { exact: true }).waitFor();
  const draft = page.getByLabel('Message to selected task'); await draft.fill('Keep this unsent draft');
  await page.getByRole('button', { name: 'Refresh fleet', exact: true }).click();
  assert.equal(await draft.inputValue(), 'Keep this unsent draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Message saved to the task inbox.', { exact: true }).waitFor();
  const sent = mutations.find(item => item.path === '/messages')!.body;
  assert.equal(sent.projectId, 'home'); assert.equal(sent.taskId, 'child'); assert.equal(sent.recipient, 'child');
  assert.equal(typeof sent.idempotencyKey, 'string'); assert.equal(sent.sender, undefined);
  await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
  await page.locator('.fleet-message').getByText('Keep this unsent draft', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).compromised), undefined);
  await page.locator('[data-task-id="failed"]').click();
  await page.getByRole('button', { name: 'Retry task', exact: true }).waitFor();
  holdVerified = true;
  await page.locator('[data-task-id="verified"]').click();
  await page.getByRole('heading', { name: 'Loading verified…', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry task', exact: true }).count(), 0, 'old-task actions must disappear while another task loads');
  releaseArtifact?.();
  await page.getByText('Verification · passed', { exact: true }).waitFor();
  await page.getByText('Delivered result', { exact: true }).waitFor();
  await page.locator('[data-task-id="failed"]').click();
  await page.getByRole('button', { name: 'Retry task', exact: true }).click();
  await page.getByText('Retry queued.', { exact: true }).waitFor();
  await page.locator('[data-task-id="root"]').click();
  await page.getByRole('button', { name: 'Cancel coordinator and children', exact: true }).click();
  await page.locator('.fleet-draining').getByText(/vendor request is still finishing/).waitFor();
  await page.getByLabel('Full task ID').fill('other');
  await page.getByRole('button', { name: 'Inspect task', exact: true }).click();
  await page.getByText('This task belongs to another project. Select that project first.', { exact: true }).waitFor();
  await page.getByLabel('Fleet project').selectOption('other-project');
  await page.locator('[data-task-id="other"]').waitFor();
  assert.equal(await page.locator('[data-task-id="root"]').count(), 0);
  await page.locator('summary').getByText('New task', { exact: true }).click();
  await page.getByLabel('New task instruction').fill('A bounded explicit task');
  await page.getByLabel('New task route').selectOption('mock');
  await page.getByRole('button', { name: 'Queue task', exact: true }).click();
  await page.getByText('Task accepted.', { exact: true }).waitFor();
  const created = mutations.find(item => item.path === '/tasks')!.body;
  assert.equal(created.projectId, 'other-project'); assert.deepEqual(created.route, { mode: 'explicit', agentId: 'mock' });
  assert.equal(created.allowPaidApi, false); assert.equal(created.decisionBudgetUsd, undefined); assert.equal(created.maxAttempts, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.RUNNER_FLEET_SCREENSHOT) await page.screenshot({ path: process.env.RUNNER_FLEET_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
});
