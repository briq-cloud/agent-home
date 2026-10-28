/**
 * The home's page, for its person: each CLI, signed in or not and until when, its sign-in, its
 * refresh, and the terminal. Plain HTML over the runner's JSON API, on the same origin.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent home</title>
<style>
:root { --bg: #fafaf9; --card: #fff; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --ok: #15803d; --warn: #b45309; --off: #a8a29e; --accent: #c2410c; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --card: #292524; --text: #f5f5f4; --muted: #a8a29e; --line: #44403c; --ok: #4ade80; --warn: #fbbf24; --off: #78716c; --accent: #fb923c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; font-weight: 600; }
a { color: var(--accent); }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.name { font-weight: 600; }
.tag { font-size: 12px; padding: 1px 8px; border-radius: 99px; border: 1px solid currentColor; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .off { color: var(--off); }
.muted { color: var(--muted); font-size: 13px; }
button { font: inherit; padding: 5px 12px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); color: var(--text); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.code { font: 600 18px ui-monospace, monospace; letter-spacing: 1px; }
input { font: inherit; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); color: var(--text); width: 100%; }
.steps { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); padding-top: 8px; }
code { font: 12px ui-monospace, monospace; background: var(--bg); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); }
</style>
</head>
<body>
<main>
  <header><h1>Agent home</h1><a href="/terminal/">Terminal</a></header>
  <div class="grid" id="clis"><p class="muted">Loading…</p></div>
</main>
<script>
const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (el.className = v) : k.startsWith('on') ? (el[k] = v) : el.setAttribute(k, v);
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
};
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const call = async (method, path, body) => {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};
const signIns = {};
let messages = {};
let usage = {};
let limited = {};
const today = () => new Date().toISOString().slice(0, 10);
const num = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const STATUS = { allowed: 'within its limits', allowed_warning: 'near a limit', rejected: 'at its limit' };
const WINDOW = { five_hour: '5 h', seven_day: 'week', seven_day_opus: 'week (Opus)' };
const when = (at) => typeof at === 'number' ? new Date(at < 1e12 ? at * 1000 : at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
/**
 * A CLI's word on its plan's limits, as it gave it: how much of each window is used (Claude's
 * \`unifiedWindows\`), else a status and when it resets.
 */
function limitsLine(l) {
  if (!l || typeof l.value !== 'object') return null;
  const v = l.value;
  const plan = 'Plan ' + (STATUS[v.status] || String(v.status || '').replace(/_/g, ' ') || 'limits');
  const windows = v.unifiedWindows && typeof v.unifiedWindows === 'object'
    ? Object.entries(v.unifiedWindows).filter(([, w]) => w && typeof w.utilization === 'number')
      .map(([name, w]) => (WINDOW[name] || name.replace(/_/g, ' ')) + ' ' + Math.round(w.utilization * 100) + '%' + (when(w.resetsAt) ? ' until ' + when(w.resetsAt) : ''))
    : [];
  if (windows.length) return plan + ': ' + windows.join(', ');
  const reset = when(v.resetsAt ?? v.resets_at);
  return v.status || reset ? plan + (reset ? ', resets ' + reset : '') : null;
}

function card(c) {
  const life = c.life;
  const signedLabel = c.signInWith === 'api-key' ? 'key set' : 'signed in';
  const outLabel = c.signInWith === 'api-key' ? 'no key' : 'signed out';
  const state = limited[c.name] ? ['at its limit', 'warn'] : c.signedIn === true ? (life && life.endsSoon ? ['ends soon', 'warn'] : [signedLabel, 'ok'])
    : c.signedIn === false ? [outLabel, 'off'] : ['unknown', 'off'];
  const box = $('div', { class: 'card' },
    $('div', { class: 'row' }, $('span', { class: 'name' }, c.name), $('span', { class: 'tag ' + state[1] }, state[0])));
  if (life && life.endsAt) box.append($('span', { class: 'muted' }, (life.renews ? 'Until ' : 'Ends ') + day(life.endsAt) + (life.renews ? ', renewed by use' : ', then sign in again')));
  const u = usage[c.name], d = u && u.days[today()];
  if (d) box.append($('span', { class: 'muted' }, 'Today ' + d.turns + (d.turns === 1 ? ' turn' : ' turns') + (d.tokens.total ? ', ' + num(d.tokens.total) + ' tokens' : '') + (d.cost ? ', ' + d.cost.amount.toFixed(2) + ' ' + d.cost.currency + ' at API prices' : '')));
  if (limited[c.name]) box.append($('span', { class: 'muted' }, 'New sessions go to another CLI until ' + new Date(limited[c.name]).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })));
  const limits = u && limitsLine(u.limits);
  if (limits) box.append($('span', { class: 'muted' }, limits));
  const s = signIns[c.name];
  if (s && s.state === 'waiting') {
    const steps = $('div', { class: 'steps' });
    steps.append($('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'Open the sign-in page'));
    if (s.code) steps.append($('span', { class: 'code' }, s.code));
    const input = $('input', { placeholder: 'Code from the page, if it shows one' });
    steps.append(input, $('div', { class: 'row' },
      $('button', { onclick: async () => { await call('POST', '/connect/' + c.name + '/input', { text: input.value.trim() }); input.value = ''; } }, 'Send code'),
      $('button', { onclick: async () => { await call('DELETE', '/connect/' + c.name); delete signIns[c.name]; render(); } }, 'Cancel')));
    box.append(steps);
  } else if (c.signInWith === 'terminal') {
    box.append($('span', { class: 'muted' }, 'Sign in from the ', $('a', { href: '/terminal/' }, 'terminal'), ': ', $('code', {}, c.command)));
  } else if (c.signInWith === 'api-key') {
    box.append($('span', { class: 'muted' }, 'Takes an API key, as a team secret: ', $('code', {}, c.apiKeys[0])));
  } else {
    const actions = $('div', { class: 'row' });
    actions.append($('button', { onclick: () => connect(c.name) }, c.signedIn ? 'Sign in again' : 'Sign in'));
    if (life && life.renews && c.signedIn) actions.append($('button', { onclick: () => refresh(c.name) }, 'Refresh'));
    box.append(actions);
  }
  if (messages[c.name]) box.append($('span', { class: 'muted' }, messages[c.name]));
  return box;
}

let last = [];
function render() {
  const grid = document.getElementById('clis');
  grid.replaceChildren(...last.map(card));
}
async function load() {
  const r = await call('GET', '/status');
  if (!r.ok) { document.getElementById('clis').replaceChildren($('p', { class: 'muted' }, 'This page needs the home\\'s link with its key.')); return; }
  last = r.body.clis;
  limited = r.body.limited || {};
  for (const c of last) if (signIns[c.name] && (c.signIn === 'done' || c.signIn === 'failed')) {
    messages[c.name] = c.signIn === 'done' ? 'Signed in' : 'Sign-in failed';
    delete signIns[c.name];
  }
  render();
}
async function connect(name) {
  messages[name] = 'Starting…'; render();
  const r = await call('POST', '/connect/' + name);
  messages[name] = r.body.state === 'waiting' ? '' : 'Sign-in ' + (r.body.state || 'failed');
  if (r.body.state === 'waiting') signIns[name] = r.body;
  render();
}
async function refresh(name) {
  messages[name] = 'Refreshing…'; render();
  const r = await call('POST', '/refresh/' + name);
  messages[name] = r.ok ? (r.body.moved ? 'Refreshed' : 'Nothing to refresh yet' + (r.body.life && r.body.life.refreshableAt ? ' (from ' + day(r.body.life.refreshableAt) + ')' : '')) : (r.body.error || 'Refresh failed');
  await load();
}
async function loadUsage() {
  const r = await call('GET', '/usage');
  if (r.ok) { usage = Object.fromEntries(r.body.clis.map((c) => [c.name, c])); render(); }
}
load();
loadUsage();
setInterval(load, 5000);
setInterval(loadUsage, 30000);
</script>
</body>
</html>
`;
