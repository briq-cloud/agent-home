const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
};
const byId = (id) => document.getElementById(id);
const names = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot', cursor: 'Cursor', grok: 'Grok Build', vibe: 'Mistral Vibe', gemini: 'Gemini' };
const icons = { claude: 'claude', codex: 'openai', copilot: 'githubcopilot', cursor: 'cursor', grok: 'grok', vibe: 'mistralai', gemini: 'googlegemini', google: 'googlegemini', openrouter: 'openrouter', zai: 'zai', kimi: 'kimi', minimax: 'minimax', alibaba: 'alibabacloud', deepseek: 'deepseek' };
const copySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
const icon = (name) => $('img', { src: '/assets/icons/' + (icons[name] || 'openrouter') + '.svg', class: 'product-icon', alt: '', width: '32', height: '32' });
const product = (id, name, sub) => $('div', { class: 'product' }, icon(id), $('div', {}, $('div', { class: 'name' }, name), sub ? $('div', { class: 'product-subtitle' }, sub) : null));
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const call = async (method, path, body) => {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};
function report(error) { byId('notice').textContent = error instanceof Error ? error.message : String(error); }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const input = $('textarea', { class: 'sr-only', 'aria-label': 'Link to copy' }, text);
    document.body.append(input); input.select();
    const copied = document.execCommand('copy'); input.remove();
    if (!copied) { window.prompt('Copy this link', text); return; }
  }
  byId('notice').textContent = 'Link copied';
}
function copyButton(text, label = 'Copy link') {
  const button = $('button', { type: 'button', class: 'icon-button', title: label, 'aria-label': label, onclick: () => copy(text).catch(report) });
  button.innerHTML = copySvg;
  return button;
}
byId('home-name').textContent = location.hostname;
byId('copy-home').innerHTML = copySvg;
byId('copy-home').onclick = async () => {
  const r = await call('GET', '/link');
  if (!r.ok) return report('Could not create the private link');
  await copy(location.origin + '/' + r.body.query);
};
let providers = {}, profiles = [], agents = [], usage = {}, limited = {}, messages = {};
const signIns = {};
let editing = false, dirty = false;
document.addEventListener('focusin', (e) => { if (e.target.closest('.card') && e.target.matches('input,select,button,summary')) editing = true; });
document.addEventListener('focusout', () => setTimeout(() => {
  if (!document.activeElement?.closest('.card')) { editing = false; if (dirty) render(); }
}, 0));
const number = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
function card(c) {
  const p = c.profile && providers[c.profile.provider];
  const name = p ? p.name : names[c.name] || c.name;
  const isKey = c.signInWith === 'api-key';
  const state = limited[c.name] ? ['At limit', 'warn'] : c.signedIn === true ? [isKey ? 'Ready' : 'Signed in', 'ok'] : c.signedIn === false ? [isKey ? 'Needs key' : 'Signed out', 'off'] : ['Not checked', 'off'];
  const box = $('article', { class: 'card', 'data-agent': c.name }, $('div', { class: 'row' }, product(c.profile?.provider || c.name, name, p ? (c.profile.model === 'openrouter/auto' ? 'Auto' : c.profile.model || 'Provider default') : isKey ? 'API key' : 'Subscription'), $('span', { class: 'tag ' + state[1] }, state[0])));
  if (c.statusSource === 'sign-in') box.append($('span', { class: 'muted' }, 'Last sign-in completed on this home'));
  if (c.signedIn === null) box.append($('span', { class: 'muted' }, c.statusSource === 'command' ? 'Sign-in check unavailable · try again shortly' : 'This CLI does not provide a sign-in check'));
  if (c.life?.endsAt) box.append($('span', { class: 'muted' }, 'Sign-in until ' + day(c.life.endsAt)));
  const u = usage[c.name], today = u?.days[new Date().toISOString().slice(0, 10)];
  if (today) box.append($('span', { class: 'muted' }, today.turns + (today.turns === 1 ? ' turn today' : ' turns today') + (today.tokens.total ? ' · ' + number(today.tokens.total) + ' tokens' : '')));
  const windows = u?.limits?.value?.unifiedWindows;
  if (windows) box.append($('span', { class: 'muted' }, Object.entries(windows).filter(([, w]) => typeof w?.utilization === 'number').map(([k, w]) => (k === 'five_hour' ? '5h' : k === 'seven_day' ? 'Week' : k.replaceAll('_', ' ')) + ' ' + Math.round(w.utilization * 100) + '%').join(' · ')));
  const s = signIns[c.name];
  if (s?.state === 'waiting') {
    const steps = $('div', { class: 'steps' });
    steps.append($('div', { class: 'row' }, $('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open sign-in page ↗'), copyButton(s.url, 'Copy sign-in link')));
    if (s.code) steps.append($('div', { class: 'row' }, $('span', { class: 'code' }, s.code), copyButton(s.code, 'Copy sign-in code')));
    if (c.name === 'claude') {
      const input = $('input', { placeholder: 'Code from the vendor page', 'aria-label': 'Sign-in code', autocomplete: 'off' });
      steps.append(input, $('button', { onclick: async () => { const r = await call('POST', '/connect/' + c.name + '/input', { text: input.value.trim() }); if (!r.ok) report('Could not send the code'); else input.value = ''; } }, 'Confirm code'));
    }
    steps.append($('button', { onclick: async () => { await call('DELETE', '/connect/' + c.name); delete signIns[c.name]; editing = false; render(); } }, 'Cancel'));
    box.append(steps);
  } else {
    const actions = $('div', { class: 'card-actions' });
    if (c.signedIn !== false) actions.append($('button', { class: 'text-button', onclick: () => selectAgent(c.name) }, 'Chat →'));
    if (c.profile) actions.append($('button', { onclick: () => dropProfile(c.name) }, 'Remove'));
    else if (c.signInWith === 'terminal') actions.append($('a', { href: '/terminal/', target: '_blank', rel: 'noopener' }, 'Sign in in terminal ↗'));
    else if (!isKey) actions.append($('button', { onclick: () => connect(c.name) }, c.signedIn ? 'Reconnect' : 'Sign in'));
    else if (!c.signedIn) actions.append($('a', { href: '#keys-section' }, 'Add key ↓'));
    if (c.life?.renews && c.signedIn) actions.append($('button', { onclick: () => refresh(c.name) }, 'Refresh'));
    box.append(actions);
  }
  if (messages[c.name]) box.append($('p', { class: 'message', role: 'status' }, messages[c.name]));
  return box;
}
function keyCard(p) {
  const box = $('article', { class: 'card', 'data-provider': p.id }, $('div', { class: 'row' }, product(p.id, p.name, p.billing === 'plan' ? 'Coding plan' : 'Billed by provider'), $('span', { class: 'tag ' + (p.set ? 'ok' : 'off') }, p.set ? 'Key saved' : 'No key')));
  if (!p.set) {
    const input = $('input', { type: 'password', placeholder: 'Paste your API key', 'aria-label': p.name + ' key', autocomplete: 'off' });
    box.append(input, $('button', { class: 'primary', onclick: () => putKey(p.id, input.value.trim()) }, 'Save & use Auto'));
  } else {
    const own = profiles.filter((q) => q.provider === p.id);
    if (p.cli) box.append($('span', { class: 'muted' }, 'Ready in ' + (names[p.cli] || p.cli)));
    else if (own.length) box.append($('span', { class: 'muted' }, 'Ready · ' + own.map((q) => q.model === 'openrouter/auto' ? 'Auto' : q.model || 'Provider default').join(', ')));
    const actions = $('div', { class: 'card-actions' });
    if (p.cli || own.length) actions.append($('button', { class: 'text-button', onclick: () => selectAgent(p.cli || own[0].name) }, 'Chat →'));
    else actions.append($('button', { class: 'primary', onclick: () => addProfile(p.id, 'auto', 'auto') }, 'Use Auto'));
    actions.append($('button', { onclick: () => putKey(p.id, '') }, 'Remove key'));
    box.append(actions);
  }
  if (p.set && p.harnesses.length) {
    const details = $('details', {}, $('summary', {}, 'Advanced'));
    const harness = $('select', { 'aria-label': p.name + ' harness' }, $('option', { value: 'auto' }, 'Auto'));
    for (const h of p.harnesses) harness.append($('option', { value: h }, names[h]));
    const model = $('input', { placeholder: 'Auto', 'aria-label': p.name + ' model' });
    details.append($('div', { class: 'advanced' }, $('label', {}, 'Agent', harness), $('label', {}, 'Model', model), $('button', { onclick: () => addProfile(p.id, harness.value, model.value.trim() || 'auto') }, 'Apply')));
    box.append(details);
  }
  if (messages['key:' + p.id]) box.append($('p', { class: 'message', role: 'status' }, messages['key:' + p.id]));
  return box;
}
function render() {
  if (editing) { dirty = true; return; }
  dirty = false;
  byId('clis').replaceChildren(...agents.map(card));
  byId('keys').replaceChildren(...Object.values(providers).map(keyCard));
  byId('connection-count').textContent = agents.filter((c) => c.signedIn).length + ' ready';
  const select = byId('chat-agent'), current = select.value;
  select.replaceChildren($('option', { value: '' }, 'Auto · subscriptions'));
  for (const c of agents) select.append($('option', { value: c.name }, c.profile ? (providers[c.profile.provider]?.name || c.name) + (c.profile.model === 'openrouter/auto' ? ' · Auto' : ' · ' + names[c.profile.harness]) : names[c.name] || c.name));
  select.value = [...select.options].some((o) => o.value === current) ? current : '';
}
async function load() {
  try {
    const [status, keys] = await Promise.all([call('GET', '/status'), call('GET', '/keys')]);
    if (!status.ok || !keys.ok) throw new Error('Open this home with its private link to connect.');
    agents = status.body.clis; limited = status.body.limited || {};
    providers = Object.fromEntries(keys.body.providers.map((p) => [p.id, p])); profiles = keys.body.profiles;
    for (const c of agents) if (signIns[c.name] && ['done', 'failed'].includes(c.signIn)) {
      messages[c.name] = c.signIn === 'done' ? 'Sign-in complete' : 'Sign-in failed'; delete signIns[c.name];
    }
    render();
  } catch (e) { report(e); }
}
async function putKey(id, key) {
  const r = key ? await call('PUT', '/keys/' + id, { key, auto: true }) : await call('DELETE', '/keys/' + id);
  messages['key:' + id] = r.ok ? '' : r.body.error || 'Could not save the key'; editing = false; await load();
}
async function addProfile(provider, harness, model) {
  const r = await call('POST', '/profiles', { provider, harness, model });
  messages['key:' + provider] = r.ok ? '' : r.body.error || 'Could not configure the provider'; editing = false; await load();
}
async function dropProfile(name) { await call('DELETE', '/profiles/' + name); editing = false; await load(); }
async function connect(name) {
  messages[name] = 'Starting sign-in…'; editing = false; render();
  const r = await call('POST', '/connect/' + name);
  messages[name] = r.ok ? (r.body.state === 'waiting' ? '' : 'Sign-in ' + r.body.state) : r.body.error || 'Sign-in failed';
  if (r.body.state === 'waiting') signIns[name] = r.body; editing = false; await load();
}
async function refresh(name) {
  messages[name] = 'Refreshing…'; editing = false; render();
  const r = await call('POST', '/refresh/' + name);
  messages[name] = r.ok ? (r.body.moved ? 'Refreshed' : 'Nothing to refresh yet') : r.body.error || 'Refresh failed'; await load();
}
// Same-origin ACP over WebSocket: only the runner cookies authenticate this connection.
let ws, session, ready, selected = '', nextId = 0, busy = false, assistant;
const pending = new Map();
const permissions = new Map();
function chatStatus(text) { byId('chat-status').textContent = text; }
function bubble(role, text) {
  const log = byId('chat-messages'); log.querySelector('.empty-chat')?.remove();
  const el = $('div', { class: 'bubble ' + role }, text); log.append(el); log.scrollTop = log.scrollHeight; return el;
}
function sendWire(message) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', ...message })); }
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The agent took too long to answer. Reconnect to resume.')); }, 10 * 60 * 1000);
    pending.set(id, { resolve, reject, timer }); sendWire({ id, method, params });
  });
}
function rejectPending(reason) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); } pending.clear(); }
function remember() { try { localStorage.setItem('agent-home-chat', JSON.stringify({ id: session, cli: selected })); } catch {} }
function permission(m) {
  const item = $('div', { class: 'permission' }, $('p', {}, m.params.toolCall?.title || 'The agent requests permission'));
  const actions = $('div', { class: 'actions' });
  const answer = (outcome) => { sendWire({ id: m.id, result: { outcome } }); permissions.delete(m.id); item.remove(); };
  permissions.set(m.id, answer);
  for (const o of m.params.options || []) actions.append($('button', { onclick: () => answer({ outcome: 'selected', optionId: o.optionId }) }, o.name));
  actions.append($('button', { onclick: () => answer({ outcome: 'cancelled' }) }, 'Cancel'));
  item.append(actions); byId('permissions').append(item); chatStatus('Waiting for your permission');
}
function receive(m) {
  if (m.id != null && !m.method) {
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return;
  }
  if (m.method === 'session/request_permission' && m.id != null) return permission(m);
  if (m.id != null) return sendWire({ id: m.id, error: { code: -32601, message: 'This client does not offer that method' } });
  if (m.method === '_runner/replay' && m.params?.prompt) {
    const text = m.params.prompt.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (text) { assistant = undefined; bubble('user', text); }
  }
  if (m.method === '_runner/turn') {
    if (m.params.state === 'queued') chatStatus('Queued · position ' + m.params.position);
    else if (m.params.state === 'running') { assistant = undefined; chatStatus('Thinking…'); }
    else if (m.params.state === 'idle') chatStatus('Ready');
  }
  const update = m.method === 'session/update' && m.params.update;
  if (!update) return;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    if (!assistant) assistant = bubble('assistant', '');
    assistant.append(update.content.text); const log = byId('chat-messages'); log.scrollTop = log.scrollHeight;
  } else if (update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text') {
    assistant = undefined; bubble('user', update.content.text);
  } else if (update.sessionUpdate === 'tool_call') {
    assistant = undefined; bubble('tool', update.title || update.kind || 'Using a tool');
  }
}
async function connection() {
  if (ready && ws?.readyState === WebSocket.OPEN) return ready;
  selected = byId('chat-agent').value;
  const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/acp'); ws = socket;
  socket.onmessage = (e) => { try { const m = JSON.parse(e.data); for (const item of Array.isArray(m) ? m : [m]) receive(item); } catch { report('Could not read an ACP message'); } };
  socket.onclose = () => { if (ws !== socket) return; ready = undefined; rejectPending('Connection closed. Send again to reconnect.'); byId('permissions').replaceChildren(); permissions.clear(); chatStatus('Disconnected · your session stays on the home'); };
  ready = (async () => {
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Cannot connect to the agent')); });
    await request('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-home-chat', version: '0.1.0' }, clientCapabilities: {} });
    if (session) {
      byId('chat-messages').replaceChildren(); assistant = undefined;
      await request('session/load', { sessionId: session, cwd: '/work', mcpServers: [] });
    } else {
      const s = await request('session/new', { cwd: '/work', mcpServers: [], ...(selected ? { _meta: { agentHome: { cli: selected } } } : {}) });
      session = s.sessionId; remember(); chatStatus('Connected · ' + (names[s._meta?.agentHome?.cli] || s._meta?.agentHome?.cli || 'agent'));
    }
  })();
  try { return await ready; } catch (e) { ready = undefined; throw e; }
}
function resetChat() {
  if (busy) return;
  ws?.close(); ws = undefined; ready = undefined; session = undefined; assistant = undefined;
  rejectPending('New conversation'); byId('chat-messages').replaceChildren(); byId('permissions').replaceChildren();
  try { localStorage.removeItem('agent-home-chat'); } catch {} chatStatus('New conversation');
}
function selectAgent(name) { if (busy) return; resetChat(); byId('chat-agent').value = name; byId('chat').scrollIntoView({ behavior: 'smooth', block: 'center' }); byId('prompt').focus(); }
byId('new-chat').onclick = resetChat;
byId('chat-agent').onchange = resetChat;
byId('stop-chat').onclick = () => { if (session) { for (const answer of permissions.values()) answer({ outcome: 'cancelled' }); sendWire({ method: 'session/cancel', params: { sessionId: session } }); chatStatus('Cancelling…'); } };
byId('chat-form').onsubmit = async (e) => {
  e.preventDefault(); const text = byId('prompt').value.trim(); if (!text || busy) return;
  busy = true; byId('send-chat').disabled = true; byId('new-chat').disabled = true; byId('chat-agent').disabled = true; byId('stop-chat').hidden = false;
  try {
    chatStatus('Connecting…'); await connection(); assistant = undefined; bubble('user', text); byId('prompt').value = '';
    chatStatus('Thinking…'); const r = await request('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] }); chatStatus(r.stopReason === 'cancelled' ? 'Cancelled' : 'Ready');
  } catch (error) { bubble('error', error.message); chatStatus('Could not complete this turn'); }
  finally { busy = false; byId('send-chat').disabled = false; byId('new-chat').disabled = false; byId('chat-agent').disabled = false; byId('stop-chat').hidden = true; byId('prompt').focus(); }
};
byId('prompt').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); byId('chat-form').requestSubmit(); } };
async function loadUsage() { const r = await call('GET', '/usage'); if (r.ok) { usage = Object.fromEntries(r.body.clis.map((c) => [c.name, c])); render(); } }
await load();
try {
  const saved = JSON.parse(localStorage.getItem('agent-home-chat') || 'null');
  if (saved?.id && typeof saved.cli === 'string') { session = saved.id; selected = saved.cli; byId('chat-agent').value = selected; chatStatus('Previous conversation available · send to reconnect'); }
} catch {}
loadUsage().catch(report);
setInterval(load, 5000);
setInterval(() => loadUsage().catch(report), 30000);
