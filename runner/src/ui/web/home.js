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
const names = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  grok: 'Grok Build',
  vibe: 'Mistral Vibe',
  gemini: 'Gemini',
};
const icons = {
  claude: 'claude',
  codex: 'openai',
  copilot: 'githubcopilot',
  cursor: 'cursor',
  grok: 'grok',
  vibe: 'mistralai',
  gemini: 'googlegemini',
  google: 'googlegemini',
  openrouter: 'openrouter',
  zai: 'zai',
  kimi: 'kimi',
  minimax: 'minimax',
  alibaba: 'alibabacloud',
  deepseek: 'deepseek',
};
const copySvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
const icon = (name) =>
  $('img', {
    src: '/assets/icons/' + (icons[name] || 'openrouter') + '.svg',
    class: 'product-icon',
    alt: '',
    width: '32',
    height: '32',
  });
const product = (id, name, sub) =>
  $(
    'div',
    { class: 'product' },
    icon(id),
    $('div', {}, $('div', { class: 'name' }, name), sub ? $('div', { class: 'product-subtitle' }, sub) : null),
  );
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const call = async (method, path, body, signal) => {
  const r = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};
function report(error) {
  byId('notice').textContent = error instanceof Error ? error.message : String(error);
}
async function copy(text, confirmation = 'Link copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = $('textarea', { class: 'sr-only', 'aria-label': 'Link to copy' }, text);
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) {
      window.prompt('Copy this link', text);
      return false;
    }
  }
  byId('notice').textContent = confirmation;
  return true;
}
function copyButton(text, label = 'Copy link') {
  const button = $('button', {
    type: 'button',
    class: 'icon-button',
    title: label,
    'aria-label': label,
    onclick: () => copy(text, label.toLowerCase().includes('code') ? 'Code copied' : 'Link copied').catch(report),
  });
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
let features = {},
  providers = {},
  profiles = [],
  agents = [],
  usage = {},
  limited = {},
  messages = {};
const signIns = {};
const signInPolls = new Map();
const composingCards = new Set();
document.addEventListener('compositionstart', (event) => {
  const card = event.target.closest('.card');
  if (card) composingCards.add(card.getAttribute('data-agent') || 'key:' + card.getAttribute('data-provider'));
});
document.addEventListener('compositionend', (event) => {
  const card = event.target.closest('.card');
  if (card) composingCards.delete(card.getAttribute('data-agent') || 'key:' + card.getAttribute('data-provider'));
  render();
});
let loading = false;
let pageActive = true;

// Replace only one card at a time. Typed values, selections and open Advanced
// controls stay local to that card; focused buttons never freeze status updates.
function replaceCard(previous, next) {
  if (!previous) return next;
  const controls = [...previous.querySelectorAll('input,textarea,select')];
  const drafts = new Map(
    controls.map((control, index) => [
      control.dataset.draft || control.tagName + ':' + (control.getAttribute('aria-label') || index),
      {
        value: control.value,
        checked: control.checked,
        focused: control === document.activeElement,
        start: control.selectionStart,
        end: control.selectionEnd,
      },
    ]),
  );
  const expanded = [...previous.querySelectorAll('details')].map((details) => details.open);
  previous.replaceWith(next);
  [...next.querySelectorAll('details')].forEach((details, index) => {
    details.open = expanded[index] || false;
  });
  [...next.querySelectorAll('input,textarea,select')].forEach((control, index) => {
    const saved = drafts.get(
      control.dataset.draft || control.tagName + ':' + (control.getAttribute('aria-label') || index),
    );
    if (!saved) return;
    control.value = saved.value;
    if (control.type === 'checkbox') control.checked = saved.checked;
    if (saved.focused && !control.disabled) {
      control.focus({ preventScroll: true });
      if (typeof saved.start === 'number') {
        try {
          control.setSelectionRange(saved.start, saved.end);
        } catch {}
      }
    }
  });
  return next;
}
function renderCards(container, values, key, create) {
  const existing = new Map([...container.children].map((node) => [node.getAttribute(key), node]));
  for (const value of values) {
    const name = key === 'data-agent' ? value.name : value.id;
    const previous = existing.get(name);
    if (previous && composingCards.has(key === 'data-agent' ? name : 'key:' + name)) {
      existing.delete(name);
      continue;
    }
    const next = create(value);
    if (previous?.dataset.renderSignature === next.dataset.renderSignature) {
      existing.delete(name);
      continue;
    }
    if (previous) replaceCard(previous, next);
    else container.append(next);
    existing.delete(name);
  }
  for (const node of existing.values()) node.remove();
}
function renderAgent(name) {
  const agent = agents.find((item) => item.name === name);
  if (!agent || composingCards.has(name)) return;
  const previous = [...byId('clis').children].find((node) => node.getAttribute('data-agent') === name);
  if (previous) {
    const next = card(agent);
    if (previous.dataset.renderSignature !== next.dataset.renderSignature) replaceCard(previous, next);
  }
}
function signInActive(view) {
  return view && ['starting', 'waiting'].includes(view.state);
}
function stopSignInPoll(name, expected) {
  const poll = signInPolls.get(name);
  if (!poll || (expected && poll !== expected)) return;
  poll.stopped = true;
  clearTimeout(poll.timer);
  poll.controller?.abort();
  signInPolls.delete(name);
}
function updateSignIn(name, state) {
  const view = signIns[name];
  if (!view || !['idle', 'starting', 'waiting', 'done', 'failed'].includes(state.state)) return;
  if (['done', 'failed'].includes(view.state) && signInActive(state)) return;
  Object.assign(view, state, { pollError: '' });
  if (!signInActive(view)) {
    view.finishing = false;
    view.submitting = false;
    view.cancelling = false;
    view.endedAt = Date.now();
    stopSignInPoll(name);
    if (view.state === 'done') {
      const agent = agents.find((item) => item.name === name);
      if (agent) {
        agent.signedIn = true;
        agent.signIn = 'done';
      }
      messages[name] = '';
      // The cheap login poll already proved completion. Refresh slower overall
      // inventory in the background without delaying this visible confirmation.
      void load();
    }
  } else if (view.finishing && !view.submitting && Date.now() - view.submittedAt > 10_000) {
    view.finishing = false;
    view.note = 'Still waiting for Claude. Check the browser, or paste the code again.';
  }
  renderAgent(name);
}
function startSignInPoll(name) {
  if (!pageActive || signInPolls.has(name) || !signInActive(signIns[name])) return;
  const view = signIns[name];
  const poll = { stopped: false, timer: undefined, controller: undefined };
  signInPolls.set(name, poll);
  const tick = async () => {
    if (poll.stopped || signIns[name] !== view || poll.controller) return;
    poll.controller = new AbortController();
    const timeout = setTimeout(() => poll.controller.abort(), 5000);
    try {
      const response = await call('GET', '/connect/' + name, undefined, poll.controller.signal);
      if (!poll.stopped && signIns[name] === view) {
        if (response.ok) updateSignIn(name, response.body);
        else {
          view.pollError = 'Could not check sign-in. Retrying…';
          renderAgent(name);
        }
      }
    } catch {
      if (!poll.stopped && signIns[name] === view) {
        view.pollError = 'Connection interrupted. Retrying…';
        renderAgent(name);
      }
    } finally {
      clearTimeout(timeout);
      poll.controller = undefined;
      if (!poll.stopped && signIns[name] === view && signInActive(view)) poll.timer = setTimeout(tick, 500);
      else stopSignInPoll(name, poll);
    }
  };
  poll.tick = tick;
  void tick();
}
function wakeSignInPoll(name) {
  const poll = signInPolls.get(name);
  if (!poll) {
    startSignInPoll(name);
    return;
  }
  if (poll.controller || poll.stopped) return;
  clearTimeout(poll.timer);
  void poll.tick();
}
function wakeSignIns() {
  for (const name of Object.keys(signIns)) wakeSignInPoll(name);
}
async function cancelSignIn(name) {
  const view = signIns[name];
  if (!view || view.cancelling) return;
  view.cancelling = true;
  renderAgent(name);
  try {
    const response = await call('DELETE', '/connect/' + name, undefined, AbortSignal.timeout(10_000));
    if (signIns[name] !== view) return;
    if (!response.ok) throw Error('cancel failed');
    updateSignIn(name, response.body);
    startSignInPoll(name);
  } catch {
    view.cancelling = false;
    view.pollError = 'Could not cancel sign-in. Try again.';
    renderAgent(name);
  }
}
async function confirmSignIn(name, input) {
  const view = signIns[name],
    code = input.value.trim();
  if (!view || !code || view.submitting || view.finishing || view.cancelling) return;
  view.submitting = true;
  view.finishing = true;
  view.submittedAt = Date.now();
  view.note = '';
  input.value = '';
  renderAgent(name);
  try {
    const response = await call('POST', '/connect/' + name + '/input', { text: code }, AbortSignal.timeout(10_000));
    if (signIns[name] !== view || !signInActive(view)) return;
    view.submitting = false;
    if (!response.ok) {
      view.finishing = false;
      view.note = 'The code could not be sent. Check it and try again, or restart sign-in.';
      updateSignIn(name, response.body);
      renderAgent(name);
      return;
    }
    updateSignIn(name, response.body);
    startSignInPoll(name);
  } catch {
    if (signIns[name] !== view || !signInActive(view)) return;
    view.submitting = false;
    view.finishing = false;
    view.note = 'The code could not be sent. Paste it again to retry.';
    renderAgent(name);
  }
}
function signInCopy(text, label, name, view) {
  return $(
    'button',
    {
      type: 'button',
      class: 'signin-copy',
      onclick: async () => {
        try {
          const copied = await copy(text, label === 'Copy code' ? 'Code copied' : 'Link copied');
          if (signIns[name] !== view) return;
          view.copyFeedback = copied
            ? label === 'Copy code'
              ? 'Code copied'
              : 'Sign-in link copied'
            : 'Select and copy the value shown.';
          renderAgent(name);
        } catch {
          view.copyFeedback = 'Could not copy. Please try again.';
          renderAgent(name);
        }
      },
    },
    label,
  );
}
function signInPanel(c, view) {
  const vendor = names[c.name] || c.name;
  const finishing = view.finishing || view.submitting;
  const title = view.cancelling
    ? 'Cancelling sign-in…'
    : view.state === 'done'
      ? 'Connected to ' + vendor
      : view.state === 'failed'
        ? view.reason === 'cancelled'
          ? 'Sign-in cancelled'
          : 'Sign-in did not finish'
        : finishing
          ? 'Finishing sign-in…'
          : view.state === 'starting'
            ? 'Preparing your sign-in…'
            : 'Continue in your browser';
  const panel = $(
    'div',
    { class: 'signin-flow', 'data-signin-state': finishing ? 'finishing' : view.state },
    $(
      'p',
      { class: 'signin-heading' + (view.state === 'done' ? ' ok' : ''), role: 'status', 'aria-live': 'polite' },
      title,
    ),
  );
  if (view.state === 'done') {
    panel.append($('p', { class: 'muted' }, 'Your ' + vendor + ' connection is ready on this home.'));
    return panel;
  }
  if (view.state === 'failed') {
    const reasons = {
      timed_out: 'This sign-in expired. Start again for a fresh link and code.',
      start_failed: 'The sign-in command could not start. Try again, or use the terminal.',
      command_failed: 'The provider did not confirm sign-in. Check the code or start again.',
      cancelled: 'No sign-in is waiting. You can try again whenever you are ready.',
    };
    panel.append(
      $('p', { class: 'muted' }, view.error || reasons[view.reason] || 'Start again for a fresh sign-in link.'),
    );
    return panel;
  }
  const progress = $('ol', { class: 'signin-progress', 'aria-label': 'Sign-in steps' });
  ['Open browser', 'Approve with ' + vendor, 'Return here'].forEach((label, index) =>
    progress.append($('li', { class: index === (finishing ? 2 : view.opened ? 1 : 0) ? 'current' : '' }, label)),
  );
  panel.append(progress);
  let url;
  try {
    const parsed = new URL(view.url);
    if (parsed.protocol === 'https:') url = parsed;
  } catch {}
  if (url) {
    panel.append(
      $('p', { class: 'signin-host' }, 'Sign in with ' + vendor + ' at ', $('strong', {}, url.hostname)),
      $(
        'div',
        { class: 'signin-browser-actions' },
        $(
          'a',
          {
            href: url.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            referrerpolicy: 'no-referrer',
            class: 'button primary signin-open',
            onclick: () => {
              view.opened = true;
              setTimeout(() => renderAgent(c.name), 0);
            },
          },
          'Open ' + vendor + ' sign-in ↗',
        ),
        signInCopy(url.href, 'Copy link', c.name, view),
      ),
    );
    if (view.code && c.name !== 'claude')
      panel.append(
        $(
          'div',
          { class: 'signin-code-row' },
          $(
            'div',
            {},
            $('span', { class: 'muted' }, 'Enter this code on the provider page'),
            $('div', { class: 'code' }, view.code),
          ),
          signInCopy(view.code, 'Copy code', c.name, view),
        ),
      );
    if (view.copyFeedback)
      panel.append($('p', { class: 'signin-copy-feedback ok', role: 'status' }, view.copyFeedback));
    panel.append(
      $(
        'p',
        { class: 'muted' },
        c.name === 'claude'
          ? 'Approve in the browser, then return here and paste the confirmation code it gives you.'
          : 'Approve in the browser, then return here. This page updates automatically.',
      ),
    );
    if (c.name === 'claude') {
      const input = $('input', {
        placeholder: 'Paste the confirmation code from Claude',
        'aria-label': 'Claude confirmation code',
        'data-draft': 'signin-code',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        ...(finishing || view.cancelling ? { disabled: '' } : {}),
      });
      const confirm = $(
        'button',
        {
          class: 'primary',
          type: 'button',
          ...(finishing || view.cancelling ? { disabled: '' } : {}),
          onclick: () => confirmSignIn(c.name, input),
        },
        finishing ? 'Confirming…' : 'Confirm code',
      );
      input.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void confirmSignIn(c.name, input);
        }
      };
      panel.append($('label', { class: 'signin-paste' }, 'Confirmation code', input), confirm);
    }
  } else
    panel.append(
      $('p', { class: 'muted signin-working' }, 'Waiting for ' + vendor + ' to prepare its secure sign-in link…'),
    );
  if (view.note || view.pollError)
    panel.append($('p', { class: 'message', role: 'status' }, view.pollError || view.note));
  panel.append(
    $(
      'button',
      {
        class: 'text-button',
        type: 'button',
        ...(view.cancelling ? { disabled: '' } : {}),
        onclick: () => cancelSignIn(c.name),
      },
      view.cancelling ? 'Cancelling…' : 'Cancel sign-in',
    ),
  );
  return panel;
}
window.addEventListener('pagehide', () => {
  pageActive = false;
  for (const name of signInPolls.keys()) stopSignInPoll(name);
});
window.addEventListener('pageshow', () => {
  pageActive = true;
  wakeSignIns();
});
window.addEventListener('focus', wakeSignIns);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) wakeSignIns();
});
const number = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
function card(c) {
  const p = c.profile && providers[c.profile.provider];
  const name = p ? p.name : names[c.name] || c.name;
  const isKey = c.signInWith === 'api-key';
  const s = signIns[c.name];
  const state = signInActive(s)
    ? [s.finishing ? 'Confirming…' : 'Connecting…', 'warn']
    : s?.state === 'done' && c.statusSource !== 'sdk'
      ? ['Signed in', 'ok']
      : limited[c.name]
        ? ['At limit', 'warn']
        : c.signedIn === true
          ? [isKey ? 'Ready' : c.statusSource === 'sign-in' ? 'Sign-in recorded' : 'Signed in', 'ok']
          : c.signedIn === false
            ? [isKey ? 'Needs key' : 'Signed out', 'off']
            : ['Not checked', 'off'];
  const box = $(
    'article',
    { class: 'card' + (signInActive(s) ? ' signin-active' : ''), 'data-agent': c.name },
    $(
      'div',
      { class: 'row' },
      product(
        c.profile?.provider || c.name,
        name,
        p
          ? c.profile.model === 'openrouter/auto'
            ? 'Auto'
            : c.profile.model || 'Provider default'
          : isKey
            ? 'API key'
            : 'Subscription',
      ),
      $('span', { class: 'tag ' + state[1] }, state[0]),
    ),
  );
  if (c.statusSource === 'sign-in')
    box.append($('span', { class: 'muted' }, 'Sign-in completion recorded here · not a live account check'));
  if (c.signedIn === null)
    box.append(
      $(
        'span',
        { class: 'muted' },
        ['command', 'acp', 'sdk'].includes(c.statusSource)
          ? 'Sign-in check unavailable · try again shortly'
          : 'No standalone account check available',
      ),
    );
  if (c.name === 'copilot' && ['sign-in', 'unavailable'].includes(c.statusSource))
    box.append(
      $(
        'a',
        { class: 'muted', href: '/terminal/', target: '_blank', rel: 'noopener' },
        'Check account in terminal: open Copilot, then /user ↗',
      ),
    );
  if (c.life?.endsAt) box.append($('span', { class: 'muted' }, 'Sign-in until ' + day(c.life.endsAt)));
  const u = usage[c.name],
    today = u?.days[new Date().toISOString().slice(0, 10)];
  if (today)
    box.append(
      $(
        'span',
        { class: 'muted' },
        today.turns +
          (today.turns === 1 ? ' turn today' : ' turns today') +
          (today.tokens.total ? ' · ' + number(today.tokens.total) + ' tokens' : ''),
      ),
    );
  const windows = u?.limits?.value?.unifiedWindows;
  if (windows)
    box.append(
      $(
        'span',
        { class: 'muted' },
        Object.entries(windows)
          .filter(([, w]) => typeof w?.utilization === 'number')
          .map(
            ([k, w]) =>
              (k === 'five_hour' ? '5h' : k === 'seven_day' ? 'Week' : k.replaceAll('_', ' ')) +
              ' ' +
              Math.round(w.utilization * 100) +
              '%',
          )
          .join(' · '),
      ),
    );
  if (s && s.state !== 'idle') box.append(signInPanel(c, s));
  if (!signInActive(s)) {
    const actions = $('div', { class: 'card-actions' });
    if (c.signedIn !== false)
      actions.append($('button', { class: 'text-button', onclick: () => selectAgent(c.name) }, 'Chat →'));
    if (c.profile) actions.append($('button', { onclick: () => dropProfile(c.name) }, 'Remove'));
    else if (c.signInWith === 'terminal')
      actions.append($('a', { href: '/terminal/', target: '_blank', rel: 'noopener' }, 'Sign in in terminal ↗'));
    else if (!isKey)
      actions.append(
        $(
          'button',
          { onclick: () => connect(c.name) },
          s?.state === 'failed' ? 'Try again' : c.signedIn ? 'Reconnect' : 'Sign in',
        ),
      );
    else if (!c.signedIn) actions.append($('a', { href: '#keys-section' }, 'Add key ↓'));
    if (c.life?.renews && c.signedIn) actions.append($('button', { onclick: () => refresh(c.name) }, 'Refresh'));
    box.append(actions);
  }
  if (messages[c.name]) box.append($('p', { class: 'message', role: 'status' }, messages[c.name]));
  box.dataset.renderSignature = JSON.stringify([c, p?.name, limited[c.name], usage[c.name], s, messages[c.name]]);
  return box;
}
function keyCard(p) {
  const box = $(
    'article',
    { class: 'card', 'data-provider': p.id },
    $(
      'div',
      { class: 'row' },
      product(p.id, p.name, p.billing === 'plan' ? 'Coding plan' : 'Billed by provider'),
      $('span', { class: 'tag ' + (p.set ? 'ok' : 'off') }, p.set ? 'Key saved' : 'No key'),
    ),
  );
  if (!p.set) {
    const input = $('input', {
      type: 'password',
      placeholder: 'Paste your API key',
      'aria-label': p.name + ' key',
      autocomplete: 'off',
    });
    box.append(
      input,
      $('button', { class: 'primary', onclick: () => putKey(p.id, input.value.trim()) }, 'Save & use Auto'),
    );
  } else {
    const own = profiles.filter((q) => q.provider === p.id);
    const autoCount = own.filter((q) => q.autoEligible === true).length;
    if (p.id === 'openrouter')
      box.append(
        $('span', { class: 'muted' }, autoCount ? 'Auto ready · ' + autoCount + ' models' : 'Auto models not ready'),
      );
    else if (p.cli) box.append($('span', { class: 'muted' }, 'Ready in ' + (names[p.cli] || p.cli)));
    else if (own.length)
      box.append(
        $(
          'span',
          { class: 'muted' },
          'Ready · ' +
            own.map((q) => (q.model === 'openrouter/auto' ? 'Auto' : q.model || 'Provider default')).join(', '),
        ),
      );
    const actions = $('div', { class: 'card-actions' });
    if (p.id === 'openrouter') {
      actions.append(
        $(
          'button',
          { class: 'text-button', onclick: () => selectAgent(features.orchestrator ? 'auto' : '') },
          'Chat →',
        ),
        $(
          'button',
          { class: autoCount ? '' : 'primary', onclick: useAutoModels },
          autoCount ? 'Refresh Auto models' : 'Use Auto',
        ),
      );
    } else if (p.cli || own.length)
      actions.append($('button', { class: 'text-button', onclick: () => selectAgent(p.cli || own[0].name) }, 'Chat →'));
    else actions.append($('button', { class: 'primary', onclick: () => addProfile(p.id, 'auto', 'auto') }, 'Use Auto'));
    actions.append($('button', { onclick: () => putKey(p.id, '') }, 'Remove key'));
    box.append(actions);
  }
  if (p.set && p.harnesses.length) {
    const details = $('details', {}, $('summary', {}, 'Advanced'));
    const harness = $('select', { 'aria-label': p.name + ' harness' }, $('option', { value: 'auto' }, 'Auto'));
    for (const h of p.harnesses) harness.append($('option', { value: h }, names[h]));
    const model = $('input', { placeholder: 'Auto', 'aria-label': p.name + ' model' });
    const profileName = $('input', { placeholder: p.id + '-claude-fast', 'aria-label': 'Optional profile name' });
    const autoEligible = $('input', { type: 'checkbox' });
    details.append(
      $(
        'div',
        { class: 'advanced' },
        $('label', {}, 'Agent', harness),
        $('label', {}, 'Model', model),
        $('label', {}, 'Profile name (optional)', profileName),
        p.id === 'openrouter' ? $('label', {}, autoEligible, 'Approve this pinned model for Auto') : null,
        $(
          'button',
          {
            onclick: () =>
              addProfile(p.id, harness.value, model.value.trim() || 'auto', {
                ...(profileName.value.trim() ? { name: profileName.value.trim() } : {}),
                ...(p.id === 'openrouter' ? { autoEligible: autoEligible.checked } : {}),
              }),
          },
          'Apply',
        ),
      ),
    );
    box.append(details);
  }
  if (messages['key:' + p.id]) box.append($('p', { class: 'message', role: 'status' }, messages['key:' + p.id]));
  box.dataset.renderSignature = JSON.stringify([
    p,
    profiles.filter((profile) => profile.provider === p.id),
    messages['key:' + p.id],
    features.orchestrator,
  ]);
  return box;
}
function render() {
  renderCards(byId('clis'), agents, 'data-agent', card);
  renderCards(byId('keys'), Object.values(providers), 'data-provider', keyCard);
  byId('connection-count').textContent =
    agents.filter((c) => c.signedIn === true && (c.statusSource !== 'sign-in' || signIns[c.name]?.state === 'done'))
      .length + ' ready';
  const select = byId('chat-agent'),
    current = select.value;
  select.replaceChildren(
    features.orchestrator
      ? $('option', { value: 'auto' }, 'Auto orchestrator')
      : $('option', { value: '' }, 'Auto · subscriptions'),
  );
  if (features.orchestrator && current === '' && session)
    select.append($('option', { value: '' }, 'Existing subscription conversation'));
  for (const c of agents)
    select.append(
      $(
        'option',
        { value: c.name },
        c.profile
          ? (providers[c.profile.provider]?.name || c.name) +
              ' · ' +
              (c.profile.model === 'openrouter/auto' ? 'Provider Auto' : c.profile.model || 'Provider default') +
              ' · ' +
              (names[c.profile.harness] || c.profile.harness)
          : names[c.name] || c.name,
      ),
    );
  select.value = [...select.options].some((o) => o.value === current) ? current : features.orchestrator ? 'auto' : '';
}
async function load() {
  if (loading) return;
  loading = true;
  const requestedAt = Date.now();
  try {
    const [status, keys] = await Promise.all([call('GET', '/status'), call('GET', '/keys')]);
    if (!status.ok || !keys.ok) throw new Error('Open this home with its private link to connect.');
    agents = status.body.clis;
    limited = status.body.limited || {};
    features = status.body.features || {};
    providers = Object.fromEntries(keys.body.providers.map((p) => [p.id, p]));
    profiles = keys.body.profiles;
    for (const c of agents) {
      const view = signIns[c.name];
      if (['starting', 'waiting'].includes(c.signIn) && (!view || view.endedAt < requestedAt)) {
        signIns[c.name] = { state: c.signIn };
        startSignInPoll(c.name);
      } else if (view?.state === 'done' && requestedAt > view.endedAt && Date.now() - view.endedAt > 3000) {
        delete signIns[c.name];
      }
    }
    render();
  } catch (e) {
    report(e);
  } finally {
    loading = false;
  }
}
function autoModelsMessage(models) {
  if (!models || !Array.isArray(models.created) || !Array.isArray(models.unavailable))
    return 'Auto models could not be checked. Use Auto to retry.';
  const readyNames = new Set(
    profiles.filter((p) => p.provider === 'openrouter' && p.autoEligible === true).map((p) => p.name),
  );
  for (const profile of models.created) if (profile.autoEligible === true) readyNames.add(profile.name);
  const count = readyNames.size,
    missing = models.unavailable.length;
  if (count)
    return (
      'Auto ready · ' +
      count +
      (count === 1 ? ' model.' : ' models.') +
      (missing ? ' ' + missing + ' unavailable; refresh to retry.' : ' Paid use still needs your chat opt-in.')
    );
  return (
    'Auto models unavailable' +
    (missing && models.unavailable[0].reason ? ': ' + models.unavailable[0].reason : '.') +
    ' Use Auto to retry.'
  );
}
async function useAutoModels() {
  messages['key:openrouter'] = 'Preparing Auto models…';
  render();
  try {
    const r = await call('POST', '/routing/models', {});
    messages['key:openrouter'] = r.ok ? autoModelsMessage(r.body) : r.body.error || 'Could not prepare Auto models';
    await load();
    if (r.ok && features.orchestrator) selectAgent('auto');
  } catch (error) {
    messages['key:openrouter'] = 'Could not prepare Auto models. Use Auto to retry.';
    render();
  }
}
async function putKey(id, key) {
  try {
    const r = key ? await call('PUT', '/keys/' + id, { key, auto: true }) : await call('DELETE', '/keys/' + id);
    messages['key:' + id] = r.ok
      ? id === 'openrouter' && key
        ? autoModelsMessage(r.body.models)
        : ''
      : r.body.error || 'Could not save the key';
    await load();
    if (r.ok && key && id === 'openrouter' && features.orchestrator) selectAgent('auto');
  } catch (error) {
    messages['key:' + id] = 'Could not save the key. Please try again.';
    render();
  }
}
async function addProfile(provider, harness, model, extra = {}) {
  const r = await call('POST', '/profiles', { provider, harness, model, ...extra });
  messages['key:' + provider] = r.ok ? '' : r.body.error || 'Could not configure the provider';
  await load();
}
async function dropProfile(name) {
  await call('DELETE', '/profiles/' + name);
  await load();
}
async function connect(name) {
  if (signInActive(signIns[name])) {
    startSignInPoll(name);
    return;
  }
  stopSignInPoll(name);
  const view = { state: 'starting' };
  signIns[name] = view;
  messages[name] = '';
  renderAgent(name);
  try {
    const response = await call('POST', '/connect/' + name, { wait: false }, AbortSignal.timeout(10_000));
    if (signIns[name] !== view) return;
    if (!response.ok) throw Error('start failed');
    updateSignIn(name, response.body);
    startSignInPoll(name);
  } catch {
    if (signIns[name] !== view) return;
    updateSignIn(name, { state: 'failed', error: 'Could not start sign-in. Try again, or use the terminal.' });
  }
}
async function refresh(name) {
  messages[name] = 'Refreshing…';
  render();
  const r = await call('POST', '/refresh/' + name);
  messages[name] = r.ok ? (r.body.moved ? 'Refreshed' : 'Nothing to refresh yet') : r.body.error || 'Refresh failed';
  await load();
}
// Same-origin ACP over WebSocket: only the runner cookies authenticate this connection.
let ws,
  session,
  ready,
  selected = 'auto',
  nextId = 0,
  busy = false,
  assistant;
const pending = new Map();
const permissions = new Map();
function chatStatus(text) {
  byId('chat-status').textContent = text;
}
function bubble(role, text) {
  const log = byId('chat-messages');
  log.querySelector('.empty-chat')?.remove();
  const el = $('div', { class: 'bubble ' + role }, text);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
function sendWire(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error('The agent took too long to answer. Reconnect to resume.'));
      },
      (selected === 'auto' && method === 'session/prompt' ? 31 : 10) * 60 * 1000,
    );
    pending.set(id, { resolve, reject, timer });
    sendWire({ id, method, params });
  });
}
function rejectPending(reason) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}
function remember() {
  try {
    localStorage.setItem(
      'agent-home-chat',
      JSON.stringify({ id: session, cli: selected, allowPaidApi: byId('allow-paid').checked }),
    );
  } catch {}
}
function permission(m) {
  const item = $(
    'div',
    { class: 'permission' },
    $('p', {}, m.params.toolCall?.title || 'The agent requests permission'),
  );
  const actions = $('div', { class: 'actions' });
  const answer = (outcome) => {
    sendWire({ id: m.id, result: { outcome } });
    permissions.delete(m.id);
    item.remove();
  };
  permissions.set(m.id, answer);
  for (const o of m.params.options || [])
    actions.append($('button', { onclick: () => answer({ outcome: 'selected', optionId: o.optionId }) }, o.name));
  actions.append($('button', { onclick: () => answer({ outcome: 'cancelled' }) }, 'Cancel'));
  item.append(actions);
  byId('permissions').append(item);
  chatStatus('Waiting for your permission');
}
function receive(m) {
  if (m.id != null && !m.method) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'session/request_permission' && m.id != null) return permission(m);
  if (m.id != null)
    return sendWire({ id: m.id, error: { code: -32601, message: 'This client does not offer that method' } });
  if (m.method === '_runner/replay' && m.params?.prompt) {
    const text = m.params.prompt
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    if (text) {
      assistant = undefined;
      bubble('user', text);
    }
  }
  if (m.method === '_runner/task') {
    chatStatus('Task ' + m.params.status + ' · ' + m.params.id.slice(0, 8));
    loadTasks().catch(report);
  }
  if (m.method === '_runner/turn') {
    if (m.params.state === 'queued') chatStatus('Queued · position ' + m.params.position);
    else if (m.params.state === 'running') {
      assistant = undefined;
      chatStatus('Thinking…');
    } else if (m.params.state === 'idle') chatStatus('Ready');
  }
  const update = m.method === 'session/update' && m.params.update;
  if (!update) return;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    if (!assistant) assistant = bubble('assistant', '');
    assistant.append(update.content.text);
    const log = byId('chat-messages');
    log.scrollTop = log.scrollHeight;
  } else if (update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text') {
    assistant = undefined;
    bubble('user', update.content.text);
  } else if (update.sessionUpdate === 'tool_call') {
    assistant = undefined;
    bubble('tool', update.title || update.kind || 'Using a tool');
  }
}
async function connection() {
  if (ready && ws?.readyState === WebSocket.OPEN) return ready;
  selected = byId('chat-agent').value;
  const endpoint =
    selected === '' ? '/acp' : features.orchestrator ? '/acp/auto' : '/acp/' + encodeURIComponent(selected);
  const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + endpoint);
  ws = socket;
  socket.onmessage = (e) => {
    if (ws !== socket) return;
    try {
      const m = JSON.parse(e.data);
      for (const item of Array.isArray(m) ? m : [m]) receive(item);
    } catch {
      report('Could not read an ACP message');
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ready = undefined;
    rejectPending('Connection closed. Send again to reconnect.');
    byId('permissions').replaceChildren();
    permissions.clear();
    chatStatus('Disconnected · your session stays on the home');
  };
  ready = (async () => {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Cannot connect to the agent'));
    });
    await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'agent-home-chat', version: '0.1.0' },
      clientCapabilities: {},
    });
    if (session) {
      byId('chat-messages').replaceChildren();
      assistant = undefined;
      const loaded = await request('session/load', { sessionId: session, cwd: '/work', mcpServers: [] });
      if (selected === 'auto' && loaded._meta?.agentHome?.allowPaidApi !== byId('allow-paid').checked) {
        resetChat(true);
        throw new Error('Conversation billing preference changed. Send again to start a new conversation.');
      }
    } else {
      const s = await request('session/new', {
        cwd: '/work',
        mcpServers: [],
        _meta: {
          agentHome: {
            projectId: 'home',
            ...(selected && selected !== 'auto' ? { cli: selected } : {}),
            allowPaidApi: selected !== 'auto' || byId('allow-paid').checked,
            ...(selected === 'auto' && byId('allow-paid').checked
              ? { maxEstimatedUsd: 0.1, decisionBudgetUsd: 0.001 }
              : {}),
          },
        },
      });
      session = s.sessionId;
      remember();
      chatStatus('Connected · ' + (names[s._meta?.agentHome?.cli] || s._meta?.agentHome?.cli || 'agent'));
    }
  })();
  try {
    return await ready;
  } catch (e) {
    ready = undefined;
    throw e;
  }
}
function resetChat(force = false) {
  if (busy && force !== true) return;
  ws?.close();
  ws = undefined;
  ready = undefined;
  session = undefined;
  assistant = undefined;
  rejectPending('New conversation');
  byId('chat-messages').replaceChildren();
  byId('permissions').replaceChildren();
  permissions.clear();
  try {
    localStorage.removeItem('agent-home-chat');
  } catch {}
  chatStatus('New conversation');
}
function selectAgent(name) {
  if (busy) return;
  resetChat();
  byId('chat-agent').value = name;
  byId('chat').scrollIntoView({ behavior: 'smooth', block: 'center' });
  byId('prompt').focus();
}
byId('new-chat').onclick = resetChat;
byId('chat-agent').onchange = resetChat;
byId('allow-paid').onchange = resetChat;
byId('stop-chat').onclick = () => {
  if (session) {
    for (const answer of permissions.values()) answer({ outcome: 'cancelled' });
    sendWire({ method: 'session/cancel', params: { sessionId: session } });
    chatStatus('Cancelling…');
  }
};
byId('chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = byId('prompt').value.trim();
  if (!text || busy) return;
  busy = true;
  byId('send-chat').disabled = true;
  byId('new-chat').disabled = true;
  byId('chat-agent').disabled = true;
  byId('allow-paid').disabled = true;
  byId('stop-chat').hidden = false;
  try {
    chatStatus('Connecting…');
    await connection();
    assistant = undefined;
    bubble('user', text);
    byId('prompt').value = '';
    chatStatus('Thinking…');
    const r = await request('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] });
    chatStatus(r.stopReason === 'cancelled' ? 'Cancelled' : 'Ready');
  } catch (error) {
    bubble('error', error.message);
    chatStatus('Could not complete this turn');
  } finally {
    busy = false;
    byId('send-chat').disabled = false;
    byId('new-chat').disabled = false;
    byId('chat-agent').disabled = false;
    byId('allow-paid').disabled = false;
    byId('stop-chat').hidden = true;
    byId('prompt').focus();
  }
};
byId('prompt').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    byId('chat-form').requestSubmit();
  }
};
async function loadUsage() {
  const r = await call('GET', '/usage');
  if (r.ok) {
    usage = Object.fromEntries(r.body.clis.map((c) => [c.name, c]));
    render();
  }
}
await load();
try {
  const saved = JSON.parse(localStorage.getItem('agent-home-chat') || 'null');
  if (
    saved?.id &&
    typeof saved.cli === 'string' &&
    [...byId('chat-agent').options].some((o) => o.value === saved.cli) &&
    (saved.cli !== 'auto' || typeof saved.allowPaidApi === 'boolean')
  ) {
    session = saved.id;
    selected = saved.cli;
    byId('chat-agent').value = selected;
    byId('allow-paid').checked = selected === 'auto' && saved.allowPaidApi === true;
    chatStatus('Previous conversation available · send to reconnect');
  }
} catch {}
loadUsage().catch(report);
setInterval(load, 5000);
setInterval(() => loadUsage().catch(report), 30000);

async function loadTasks() {
  if (!features.orchestrator) {
    byId('task-list').replaceChildren($('p', { class: 'muted' }, 'Orchestrator disabled'));
    return;
  }
  const r = await call('GET', '/tasks?projectId=home');
  if (!r.ok) return;
  const cards = await Promise.all(
    r.body.tasks
      .slice(-12)
      .reverse()
      .map(async (t) => {
        const box = $(
          'article',
          { class: 'card' },
          $(
            'div',
            { class: 'row' },
            $('strong', {}, (t.parentId ? 'Child · ' : '') + t.id.slice(0, 8)),
            $('span', { class: 'tag' }, t.status),
          ),
          $(
            'p',
            { class: 'muted' },
            (t.route.agentId || 'Auto') +
              ' · ' +
              (t.costMicros == null ? 'Cost unknown' : '$' + (t.costMicros / 1e6).toFixed(4)),
          ),
        );
        if (['queued', 'running'].includes(t.status))
          box.append(
            $(
              'button',
              {
                onclick: async () => {
                  await call('POST', '/tasks/' + t.id + '/cancel');
                  loadTasks().catch(report);
                },
              },
              'Cancel',
            ),
          );
        if (t.status === 'failed' && t.attempts < t.maxAttempts)
          box.append(
            $(
              'button',
              {
                onclick: async () => {
                  await call('POST', '/tasks/' + t.id + '/retry');
                  loadTasks().catch(report);
                },
              },
              'Retry',
            ),
          );
        if (t.errorRef)
          box.append(
            $(
              'button',
              {
                onclick: async () => {
                  const a = await call('GET', '/artifacts/home/' + t.errorRef);
                  if (a.ok) {
                    try {
                      box.append($('p', {}, JSON.parse(a.body.content).message));
                    } catch {
                      box.append($('p', {}, 'Task failed'));
                    }
                  }
                },
              },
              'Details',
            ),
          );
        if (t.outputRef)
          box.append(
            $(
              'button',
              {
                onclick: async () => {
                  const a = await call('GET', '/artifacts/home/' + t.outputRef);
                  if (a.ok) {
                    try {
                      const output = JSON.parse(a.body.content);
                      if (typeof output.verification?.status === 'string')
                        box.append($('p', { class: 'muted' }, 'Verification · ' + output.verification.status));
                      box.append($('pre', {}, output.text || a.body.content));
                    } catch {
                      box.append($('pre', {}, a.body.content));
                    }
                  }
                },
              },
              'Result',
            ),
          );
        if (t.permissionRef && t.status === 'running') {
          const p = await call('GET', '/tasks/' + t.id + '/permissions');
          for (const item of p.body.permissions || []) {
            box.append($('p', {}, item.params.toolCall?.title || 'Permission requested'));
            for (const option of item.params.options || [])
              box.append(
                $(
                  'button',
                  {
                    onclick: async () => {
                      await call('POST', '/tasks/' + t.id + '/permissions/' + item.requestId, {
                        optionId: option.optionId,
                      });
                      loadTasks().catch(report);
                    },
                  },
                  option.name,
                ),
              );
          }
        }
        return box;
      }),
  );
  byId('task-list').replaceChildren(
    ...(cards.length ? cards : [$('p', { class: 'muted' }, 'Auto conversations appear here.')]),
  );
}
byId('allow-paid').onchange = () => {
  if (!busy) resetChat();
};
loadTasks().catch(report);
setInterval(() => loadTasks().catch(report), 5000);
