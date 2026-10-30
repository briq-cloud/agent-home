const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};
const encode = encodeURIComponent;
const statusNames = {
  ready: 'Delivery configured',
  disabled: 'Disabled',
  auth_required: 'Authorization required',
  unsupported: 'Transport unsupported',
  unverified: 'Delivery unverified',
};
const field = (label, control) => el('label', {}, label, control);
const refsFor = (text, transport) => {
  let refs;
  try {
    refs = JSON.parse(text || '{}');
  } catch {
    throw Error('Credential references must be valid JSON.');
  }
  if (!refs || typeof refs !== 'object' || Array.isArray(refs))
    throw Error('Credential references must be a JSON object.');
  const env = (value) => typeof value === 'string' && /^[A-Z_][A-Z0-9_]{0,95}$/.test(value);
  for (const [name, ref] of Object.entries(refs)) {
    if (!(transport === 'stdio' ? env(name) : /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)))
      throw Error('Invalid credential reference destination.');
    if (env(ref)) continue;
    if (
      transport !== 'stdio' &&
      ref &&
      typeof ref === 'object' &&
      !Array.isArray(ref) &&
      Object.keys(ref).sort().join(',') === 'env,prefix' &&
      env(ref.env) &&
      typeof ref.prefix === 'string' &&
      ref.prefix.length <= 64 &&
      !/[\r\n\0]/.test(ref.prefix)
    )
      continue;
    throw Error(
      'Use environment variable names, or HTTP {env, prefix} references. Never paste a credential value here.',
    );
  }
  return refs;
};

/** Owner-facing registry controls. Refresh replaces inspection lists, never draft forms. */
export function createExtensions({ root, request, getFeatures }) {
  let pending,
    activeMutation = false,
    generation = 0;
  const notice = el('p', { role: 'status', 'aria-live': 'polite', class: 'fleet-notice' });
  const servers = el('div'),
    skills = el('div');
  const panel = el(
    'details',
    { class: 'extensions-panel' },
    el('summary', {}, 'Skills and MCP tools'),
    el(
      'p',
      { class: 'muted' },
      'Configure shared skills and tool connections for new native chat opens and loads. Active chats are not rebound or revoked. Delivery status describes configuration, not verified remote authentication.',
    ),
    el('button', { type: 'button', onclick: () => refresh().catch(showError) }, 'Refresh extensions'),
    notice,
    el('h3', {}, 'MCP connections'),
    servers,
    serverForm(),
    el('h3', {}, 'Skills'),
    skills,
    skillForm(),
  );
  root.replaceChildren(panel);
  root.setAttribute('aria-label', 'Shared skills and tools');
  function showError(error) {
    notice.textContent = error instanceof Error ? error.message : String(error);
    notice.classList.add('warn');
  }
  function inform(message) {
    notice.textContent = message;
    notice.classList.remove('warn');
  }
  async function api(method, path, body) {
    const response = await request(method, path, body);
    if (!response.ok) {
      const messages = {
        invalid_extension_configuration:
          'Configuration rejected. Check the name, installed command, URL and environment references; deployment-owned entries cannot be replaced or deleted.',
        extensions_disabled: 'Shared extensions are disabled.',
        runner_stopping: 'The home is stopping. Try again after it restarts.',
      };
      throw Error(messages[response.body?.error] || 'Extension request failed. Refresh and try again.');
    }
    return response.body;
  }
  async function mutate(button, operation, message) {
    if (activeMutation) return;
    activeMutation = true;
    button.disabled = true;
    try {
      const result = await operation();
      const conflicts = result.links?.filter((link) => link.status === 'conflict').map((link) => link.name) || [];
      await refresh();
      inform(
        message +
          (conflicts.length
            ? ' User replacements preserved; discovery-link conflicts: ' + [...new Set(conflicts)].join(', ') + '.'
            : ''),
      );
    } catch (error) {
      showError(error);
    } finally {
      activeMutation = false;
      button.disabled = false;
    }
  }
  async function refresh() {
    root.hidden = getFeatures().extensions !== true;
    if (root.hidden) {
      generation++;
      return;
    }
    if (pending) return pending;
    const current = ++generation;
    pending = (async () => {
      const data = await api('GET', '/extensions');
      if (current !== generation || getFeatures().extensions !== true) return;
      servers.replaceChildren(
        ...(data.servers.length
          ? data.servers.map((server) => {
              const card = el(
                'article',
                { class: 'extension-entry' },
                el('h4', {}, server.name),
                el('p', { class: 'muted' }, server.transport + ' · ' + (server.url || server.command)),
                el(
                  'p',
                  { class: 'muted' },
                  server.enabled === false
                    ? 'Disabled in the registry'
                    : server.required
                      ? 'Required for new chats'
                      : 'Optional for new chats',
                ),
              );
              const refs = server.transport === 'stdio' ? server.envRefs : server.headerEnvRefs;
              if (refs && Object.keys(refs).length)
                card.append(
                  el(
                    'details',
                    {},
                    el('summary', {}, 'Credential environment references'),
                    el('pre', {}, JSON.stringify(refs, null, 2)),
                  ),
                );
              const statuses = (data.agents || []).flatMap((agent) =>
                (agent.statuses || [])
                  .filter((status) => status.name === server.name)
                  .map((status) =>
                    el(
                      'li',
                      {},
                      agent.cli +
                        ' · ' +
                        (statusNames[status.status] || 'Status unreported') +
                        (status.reason ? ' · ' + status.reason : ''),
                    ),
                  ),
              );
              card.append(
                statuses.length
                  ? el('ul', {}, statuses)
                  : el('p', { class: 'muted' }, 'No CLI delivery status reported.'),
              );
              card.append(
                el(
                  'button',
                  {
                    type: 'button',
                    onclick: (event) =>
                      mutate(
                        event.currentTarget,
                        () => api('DELETE', '/extensions/mcp/' + encode(server.name)),
                        'Connection removed for future native session opens and loads.',
                      ),
                  },
                  'Delete connection ' + server.name,
                ),
              );
              return card;
            })
          : [el('p', { class: 'muted' }, 'No shared MCP connections configured.')]),
      );
      skills.replaceChildren(
        ...(data.skills.length
          ? data.skills.map((skill) =>
              el(
                'article',
                { class: 'extension-entry' },
                el('h4', {}, skill.name),
                el('p', {}, skill.description),
                el('p', { class: 'muted' }, 'SHA-256 · ', el('code', {}, skill.hash)),
                el(
                  'button',
                  {
                    type: 'button',
                    onclick: (event) =>
                      mutate(
                        event.currentTarget,
                        () => api('DELETE', '/extensions/skills/' + encode(skill.name)),
                        'Skill removed from verified managed discovery links. User files and canonical content are preserved; active chats may retain loaded instructions.',
                      ),
                  },
                  'Delete skill ' + skill.name,
                ),
              ),
            )
          : [el('p', { class: 'muted' }, 'No shared skills configured.')]),
      );
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  }
  function skillForm() {
    const name = el('input', {
      'aria-label': 'Shared skill name',
      placeholder: 'home-my-workflow',
      pattern: 'home-[a-z0-9-]+',
      maxlength: '64',
      required: true,
    });
    const description = el('input', { 'aria-label': 'Shared skill description', maxlength: '1024', required: true });
    const body = el('textarea', {
      'aria-label': 'Shared skill instructions',
      rows: '5',
      maxlength: '64000',
      required: true,
    });
    const save = el('button', { type: 'submit' }, 'Save skill');
    const form = el(
      'form',
      {
        class: 'fleet-new-form',
        onsubmit: (event) => {
          event.preventDefault();
          const input = { name: name.value.trim(), description: description.value.trim(), body: body.value };
          mutate(
            save,
            () => api('PUT', '/extensions/skills/' + encode(input.name), input),
            'Skill saved. It applies at the next native session open or load.',
          ).catch(showError);
        },
      },
      field('Namespaced skill name', name),
      field('When to use it', description),
      field('Trusted workflow instructions', body),
      el(
        'p',
        { class: 'muted' },
        'Saves a SKILL.md instruction package. Review instructions before sharing them. Saving does not download or execute a program. Use the same name to update your managed skill.',
      ),
      save,
    );
    return el('details', { class: 'fleet-composer' }, el('summary', {}, 'Add or update a skill'), form);
  }
  function serverForm() {
    const name = el('input', {
      'aria-label': 'MCP connection name',
      pattern: '[a-z][a-z0-9-]*',
      maxlength: '64',
      required: true,
    });
    const transport = el(
      'select',
      { 'aria-label': 'MCP transport' },
      ...['http', 'stdio', 'sse'].map((value) =>
        el('option', { value }, value === 'stdio' ? 'Local stdio' : value.toUpperCase()),
      ),
    );
    const url = el('input', {
      'aria-label': 'MCP server URL',
      type: 'url',
      placeholder: 'https://service.example/mcp',
      required: true,
    });
    const command = el('input', {
      'aria-label': 'Installed MCP command',
      placeholder: '/usr/local/bin/mcp-server',
      pattern: '/.*',
    });
    const args = el('textarea', {
      'aria-label': 'MCP command arguments',
      rows: '3',
      placeholder: 'One argument per line',
    });
    const remote = field('Server endpoint', url),
      local = el(
        'div',
        { class: 'fleet-new-form', hidden: true },
        field('Installed absolute executable path', command),
        field('Arguments, one per line', args),
      );
    transport.onchange = () => {
      const stdio = transport.value === 'stdio';
      remote.hidden = stdio;
      local.hidden = !stdio;
      url.required = !stdio;
      command.required = stdio;
    };
    const refs = el('textarea', {
      'aria-label': 'MCP credential environment references JSON',
      rows: '4',
      placeholder: '{}',
      spellcheck: 'false',
    });
    const required = el('input', { type: 'checkbox', 'aria-label': 'Require MCP connection for new chats' });
    const enabled = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Enable MCP connection' });
    const save = el('button', { type: 'submit' }, 'Save MCP connection');
    const form = el(
      'form',
      {
        class: 'fleet-new-form',
        onsubmit: (event) => {
          event.preventDefault();
          let input;
          try {
            const transportValue = transport.value,
              refsValue = refsFor(refs.value, transportValue);
            input = {
              name: name.value.trim(),
              transport: transportValue,
              enabled: enabled.checked,
              required: required.checked,
              ...(transportValue === 'stdio'
                ? {
                    command: command.value.trim(),
                    args: args.value.split(/\r?\n/).filter((value) => value.length),
                    envRefs: refsValue,
                  }
                : { url: url.value.trim(), headerEnvRefs: refsValue }),
            };
          } catch (error) {
            showError(error);
            return;
          }
          mutate(
            save,
            () => api('PUT', '/extensions/mcp/' + encode(input.name), input),
            'MCP connection saved. Delivery is configured for supported new native session opens and loads.',
          ).catch(showError);
        },
      },
      el('div', { class: 'fleet-form-grid' }, field('Connection name', name), field('Transport', transport)),
      remote,
      local,
      el(
        'details',
        {},
        el('summary', {}, 'Credential references (advanced)'),
        el(
          'p',
          { class: 'muted' },
          'Environment variable NAMES only. HTTP example: {"Authorization":{"env":"MY_MCP_TOKEN","prefix":"Bearer "}}. Stdio example: {"CHILD_TOKEN":"MY_MCP_TOKEN"}. Credentials must already be provided privately by the operator.',
        ),
        refs,
      ),
      field('Enable this connection', enabled),
      field('Require this connection for new chats', required),
      el(
        'p',
        { class: 'muted' },
        'Saving registers an installed command or endpoint; it does not execute or download programs, sign in, or grant tool permissions. Briq deployment connections require owner authorization. Use the same name to update an owner-managed connection.',
      ),
      save,
    );
    return el('details', { class: 'fleet-composer' }, el('summary', {}, 'Add or update an MCP connection'), form);
  }
  return { refresh };
}
