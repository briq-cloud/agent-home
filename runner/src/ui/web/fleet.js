const element = (tag, attrs = {}, ...children) => {
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
const working = task => ['queued', 'running'].includes(task.status);
const short = id => String(id).slice(0, 12);
const timestamp = value => value ? new Date(value).toLocaleString() : '—';
const describeRoute = route => route?.cli || route?.agentId || 'Auto';
const freshId = prefix => prefix + '-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
const textOf = artifact => typeof artifact === 'string' ? artifact : JSON.stringify(artifact, null, 2);

/** One project-scoped inspector. All mutations require an explicit user action. */
export function createFleet({ root, request, getAgents, getFeatures }) {
  const state = { project: 'home', selected: null, pages: new Map(), nextOffset: null,
    extra: new Map(), capabilities: null, initialized: false, pending: null, rerun: false, historyRequested: false,
    messagePages: new Map(), messageNext: null, messageFor: null };
  const artifacts = new Map(), drafts = new Map();
  let messageRequestId, createRequestId, detailGeneration = 0;
  root.classList.remove('grid'); root.classList.add('fleet');
  document.getElementById('tasks-title').textContent = 'Fleet';
  const notice = element('p', { class: 'fleet-notice', role: 'status', 'aria-live': 'polite' });
  const project = element('select', { 'aria-label': 'Fleet project' });
  const filter = element('select', { 'aria-label': 'Task status filter' },
    ...[['all', 'All states'], ['working', 'Working'], ['attention', 'Needs attention'], ['finished', 'Finished']]
      .map(([value, label]) => element('option', { value }, label)));
  const search = element('input', { 'aria-label': 'Filter loaded tasks', placeholder: 'Filter IDs or routes' });
  const lookup = element('input', { 'aria-label': 'Full task ID', placeholder: 'Inspect a full task ID', maxlength: '256' });
  const capacity = element('p', { class: 'muted fleet-capacity' });
  const draining = element('div', { class: 'fleet-draining', role: 'status', hidden: true });
  const summary = element('p', { class: 'muted', role: 'status' });
  const tree = element('nav', { class: 'fleet-tree', 'aria-label': 'Task hierarchy' });
  const more = element('button', { type: 'button', onclick: () => loadMore().catch(showError) }, 'Load more tasks');
  const header = element('div', { class: 'fleet-toolbar' }, element('label', {}, 'Project', project),
    element('label', {}, 'Show', filter), search,
    element('button', { type: 'button', onclick: () => refresh(true).catch(showError) }, 'Refresh fleet'));
  const lookupForm = element('form', { class: 'fleet-lookup', onsubmit: event => {
    event.preventDefault(); inspect(lookup.value.trim()).catch(showError);
  } }, lookup, element('button', { type: 'submit' }, 'Inspect task'));
  const detailTitle = element('h3', {}, 'Select a task');
  const facts = element('div', { class: 'fleet-facts' }), links = element('div', { class: 'fleet-links' });
  const actions = element('div', { class: 'actions fleet-actions' });
  const prompt = element('div'), result = element('div'), approvals = element('div');
  const inbox = element('div', { class: 'fleet-messages' });
  const messageText = element('textarea', { 'aria-label': 'Message to selected task', rows: '2', maxlength: '8192', placeholder: 'Send a message to this task’s inbox…' });
  const sendMessage = element('button', { type: 'submit' }, 'Send message');
  const messageForm = element('form', { class: 'fleet-message-form', hidden: true, onsubmit: event => {
    event.preventDefault(); send().catch(showError);
  } }, messageText, element('div', { class: 'fleet-message-footer' },
    element('span', { class: 'muted' }, 'Saved to the inbox; agents read it when they check messages.'), sendMessage));
  const moreMessages = element('button', { type: 'button', hidden: true, onclick: () => loadMoreMessages().catch(showError) }, 'Load more messages');
  const detail = element('section', { class: 'fleet-detail', 'aria-label': 'Selected task' }, detailTitle, facts, links, actions,
    approvals, prompt, result, element('h4', {}, 'Received messages'), inbox, moreMessages, messageForm);
  const composer = buildComposer();
  const columns = element('div', { class: 'fleet-columns' }, element('div', { class: 'fleet-list' }, summary, tree, more), detail);
  root.replaceChildren(header, capacity, draining, composer, notice, lookupForm, columns);
  filter.onchange = drawTree; search.oninput = drawTree;
  project.onchange = () => {
    saveDraft(); state.project = project.value; state.selected = null; state.pages.clear(); state.extra.clear();
    state.messagePages.clear(); state.messageFor = null; state.nextOffset = null; detailGeneration++;
    createRequestId = undefined; messageRequestId = undefined;
    tree.replaceChildren(element('p', { class: 'muted' }, 'Loading project…')); delete tree.dataset.signature;
    summary.textContent = ''; more.hidden = true;
    messageForm.hidden = true; facts.replaceChildren(); links.replaceChildren(); actions.replaceChildren();
    prompt.replaceChildren(); result.replaceChildren(); approvals.replaceChildren(); inbox.replaceChildren();
    for (const node of [facts, links, actions, prompt, result, approvals, inbox]) delete node.dataset.signature;
    detailTitle.textContent = 'Select a task'; refresh().catch(showError);
  };
  messageText.oninput = () => { messageRequestId = undefined; };
  function showError(error) { notice.textContent = error instanceof Error ? error.message : String(error); notice.classList.add('warn'); }
  function inform(text) { notice.textContent = text; notice.classList.remove('warn'); }
  async function api(method, path, body) {
    const response = await request(method, path, body);
    if (!response.ok) throw Error(response.body?.error || 'Request failed. Refresh and try again.');
    return response.body;
  }
  function allTasks() {
    const unique = new Map();
    for (const tasks of state.pages.values()) for (const task of tasks) if (task.projectId === state.project) unique.set(task.id, task);
    for (const task of state.extra.values()) if (task.projectId === state.project && !unique.has(task.id)) unique.set(task.id, task);
    return [...unique.values()];
  }
  function rememberTask(task) {
    for (const [offset, tasks] of state.pages) {
      const index = tasks.findIndex(value => value.id === task.id);
      if (index >= 0) { const page = [...tasks]; page[index] = task; state.pages.set(offset, page); state.extra.delete(task.id); return; }
    }
    state.extra.delete(task.id); state.extra.set(task.id, task);
    if (state.extra.size > 32) state.extra.delete(state.extra.keys().next().value);
  }
  function paint(node, signature, build) {
    const key = JSON.stringify(signature);
    if (node.dataset.signature === key) return;
    node.replaceChildren(...[build()].flat().filter(Boolean)); node.dataset.signature = key;
  }
  function saveDraft() {
    if (state.selected) drafts.set(state.project + ':' + state.selected, messageText.value);
    if (drafts.size > 32) drafts.delete(drafts.keys().next().value);
  }
  async function taskPage(offset, projectId = state.project) {
    return api('GET', '/tasks?projectId=' + encode(projectId) + '&limit=100&offset=' + offset);
  }
  async function initialize() {
    if (state.initialized) return;
    const [projects, features] = await Promise.all([api('GET', '/projects'), api('GET', '/features')]);
    project.replaceChildren(...projects.projects.map(item => element('option', { value: item.id }, item.id)));
    if (!projects.projects.some(item => item.id === state.project)) state.project = projects.projects[0]?.id || '';
    project.value = state.project; state.capabilities = features; state.initialized = true;
    showCapacity(features);
    updateRoutes();
  }
  function showCapacity(features) {
    state.capabilities = features;
    const c = features.concurrency || {}, fleet = features.fleet || {};
    capacity.textContent = 'Configured: ' + (c.coordinators ?? '?') + ' coordinator(s), ' + (c.children ?? '?') +
      ' child slot(s), depth ' + (c.maxDepth ?? '?') + '. Delegation ' + (features.delegation ? 'enabled.' : 'disabled.') +
      (typeof fleet.occupiedSlots === 'number' ? ' ' + fleet.occupiedSlots + ' / ' + fleet.totalSlots + ' slots occupied.' : '') +
      ' Overlapping project roots remain serialized.';
    draining.hidden = !fleet.draining?.length;
    draining.replaceChildren();
    if (fleet.draining?.length) draining.append(element('p', {}, 'Cancellation recorded; a vendor request is still finishing. Its workspace and slot remain occupied until it ends.'),
      element('ul', {}, fleet.draining.map(item => element('li', {}, item.projectId + ' · ', element('code', {}, item.taskId)))));
  }
  async function refresh(history = false) {
    const enabled = !!getFeatures().orchestrator;
    for (const node of [header, composer, lookupForm, columns]) node.hidden = !enabled;
    if (!enabled) { capacity.textContent = getFeatures().orchestrator === false ? 'Orchestrator disabled' : 'Fleet status unavailable'; return; }
    if (state.pending) { state.rerun = true; state.historyRequested ||= history; return state.pending; }
    history ||= state.historyRequested; state.historyRequested = false;
    state.pending = (async () => {
      await initialize(); if (!state.project) return;
      showCapacity(await api('GET', '/features'));
      const currentProject = state.project;
      const offsets = history ? [...state.pages.keys()] : [...state.pages.entries()]
        .filter(([offset, tasks]) => offset === 0 || tasks.some(task => working(task) || task.id === state.selected)).map(([offset]) => offset);
      if (!offsets.includes(0)) offsets.unshift(0);
      for (const offset of offsets.slice(0, 10)) {
        const page = await taskPage(offset, currentProject);
        if (state.project !== currentProject) return;
        state.pages.set(offset, page.tasks);
        if (offset === Math.max(...state.pages.keys())) state.nextOffset = page.nextOffset ?? null;
      }
      const extra = [...state.extra.values()].filter(task => task.id !== state.selected && (history || working(task)));
      const snapshots = await Promise.all(extra.slice(0, 32).map(task => api('GET', '/tasks/' + encode(task.id))));
      if (state.project !== currentProject) return;
      for (const task of snapshots) if (task.projectId === currentProject) rememberTask(task);
      updateRoutes(); drawTree();
      if (state.selected) await drawDetail();
    })();
    try { await state.pending; } catch (error) { showError(error); throw error; } finally {
      state.pending = null;
      if (state.rerun) { state.rerun = false; void refresh(state.historyRequested).catch(showError); }
    }
  }
  async function loadMore() {
    if (state.nextOffset === null || state.pages.size >= 10) return;
    more.disabled = true; const projectId = state.project;
    try {
      const offset = state.nextOffset, page = await taskPage(offset, projectId);
      if (projectId !== state.project) return;
      state.pages.set(offset, page.tasks); state.nextOffset = page.nextOffset ?? null; drawTree();
    } finally { more.disabled = false; }
  }
  function drawTree() {
    const tasks = allTasks(), byId = new Map(tasks.map(task => [task.id, task]));
    const signature = JSON.stringify([state.selected, filter.value, search.value, state.nextOffset, state.pages.size,
      tasks.map(task => [task.id, task.parentId, task.status, task.route, task.permissionRef])]);
    if (tree.dataset.signature === signature) return; tree.dataset.signature = signature;
    const position = tree.scrollTop, childrenByParent = new Map();
    for (const task of tasks) {
      const children = childrenByParent.get(task.parentId) || []; children.push(task); childrenByParent.set(task.parentId, children);
    }
    const matches = task => {
      const term = search.value.trim().toLowerCase();
      const stateMatches = filter.value === 'all' || filter.value === 'working' && working(task) ||
        filter.value === 'attention' && (['failed', 'blocked'].includes(task.status) || task.permissionRef && task.status === 'running') ||
        filter.value === 'finished' && !working(task);
      return stateMatches && (!term || (task.id + ' ' + describeRoute(task.route) + ' ' + (task.route?.model || '')).toLowerCase().includes(term));
    };
    const visible = new Set(tasks.filter(matches).map(task => task.id));
    for (const task of tasks.filter(matches)) {
      let parent = task.parentId; const visited = new Set();
      while (parent && byId.has(parent) && !visited.has(parent)) { visible.add(parent); visited.add(parent); parent = byId.get(parent).parentId; }
    }
    const visited = new Set();
    const branch = task => {
      if (visited.has(task.id) || !visible.has(task.id)) return null; visited.add(task.id);
      const button = element('button', { type: 'button', class: 'fleet-task' + (task.id === state.selected ? ' selected' : ''),
        'aria-pressed': String(task.id === state.selected), 'data-task-id': task.id, onclick: () => inspect(task.id).catch(showError) },
        element('span', { class: 'fleet-task-title' }, (task.parentId ? 'Child ' : 'Coordinator ') + short(task.id)),
        element('span', { class: 'fleet-state ' + task.status }, task.status),
        element('span', { class: 'muted' }, 'Requested: ' + describeRoute(task.route) + (task.permissionRef && task.status === 'running' ? ' · Permission pending' : '')));
      const item = element('li', {}, button);
      const children = (childrenByParent.get(task.id) || []).filter(child => visible.has(child.id)).map(branch).filter(Boolean);
      if (children.length) item.append(element('ul', {}, children));
      return item;
    };
    const roots = tasks.filter(task => !task.parentId || !byId.has(task.parentId)).map(branch).filter(Boolean);
    roots.push(...tasks.filter(task => !visited.has(task.id)).map(branch).filter(Boolean));
    tree.replaceChildren(roots.length ? element('ul', {}, roots) : element('p', { class: 'muted' }, 'No matching tasks in the loaded pages.'));
    tree.scrollTop = position;
    const counts = tasks.reduce((value, task) => { value[task.status] = (value[task.status] || 0) + 1; return value; }, {});
    summary.textContent = tasks.length + ' loaded · ' + (counts.running || 0) + ' running · ' + (counts.queued || 0) + ' queued · ' +
      ((counts.failed || 0) + (counts.blocked || 0)) + ' need attention';
    more.hidden = state.nextOffset === null || state.pages.size >= 10;
    if (state.pages.size >= 10 && state.nextOffset !== null) summary.append(' · View capped at 1,000 tasks; inspect another full ID above.');
  }
  async function inspect(id) {
    if (!id) return;
    const task = await api('GET', '/tasks/' + encode(id));
    if (task.projectId !== state.project) throw Error('This task belongs to another project. Select that project first.');
    const changed = state.selected !== task.id;
    saveDraft(); state.selected = task.id; rememberTask(task);
    if (changed) {
      detailTitle.textContent = 'Loading ' + short(task.id) + '…';
      for (const node of [facts, links, actions, prompt, result, approvals, inbox]) { node.replaceChildren(); delete node.dataset.signature; }
      messageForm.hidden = true; moreMessages.hidden = true;
    }
    state.messagePages.clear(); state.messageFor = task.id; state.messageNext = null;
    messageText.value = drafts.get(state.project + ':' + task.id) || ''; messageRequestId = undefined;
    inform(''); drawTree(); await drawDetail();
  }
  async function artifact(projectId, ref) {
    if (!ref) return null;
    const key = projectId + ':' + ref;
    if (artifacts.has(key)) return artifacts.get(key);
    const data = await api('GET', '/artifacts/' + encode(projectId) + '/' + encode(ref));
    let value; try { value = JSON.parse(data.content); } catch { value = data.content; }
    artifacts.set(key, value); if (artifacts.size > 64) artifacts.delete(artifacts.keys().next().value);
    return value;
  }
  async function drawDetail() {
    const id = state.selected, projectId = state.project, generation = ++detailGeneration;
    const task = await api('GET', '/tasks/' + encode(id));
    if (state.selected !== id || state.project !== projectId || generation !== detailGeneration) return;
    if (task.projectId !== projectId) throw Error('Task project changed; refresh the fleet.');
    rememberTask(task); drawTree();
    const [session, output, error, input, pending] = await Promise.all([
      artifact(projectId, task.sessionRef), artifact(projectId, task.outputRef), artifact(projectId, task.errorRef), artifact(projectId, task.promptRef),
      task.status === 'running' ? api('GET', '/tasks/' + encode(id) + '/permissions') : Promise.resolve({ permissions: [] }),
    ]);
    if (state.selected !== id || state.project !== projectId || generation !== detailGeneration) return;
    detailTitle.textContent = (task.parentId ? 'Child · ' : 'Coordinator · ') + short(id);
    const actual = session?.route || output?.route;
    const rows = [ ['Task ID', id], ['State', task.status], ['Requested route', describeRoute(task.route)],
      ['Last reported route', session?.cli || actual?.cli || 'Not dispatched'], ['Last reported model', actual?.model || 'Not reported'],
      ['Attempts', task.attempts + ' / ' + task.maxAttempts], ['Runtime', Math.round(task.runtimeMs / 1000) + ' s'],
      ['Runtime limit', task.maxRuntimeMs ? Math.round(task.maxRuntimeMs / 1000) + ' s' : 'Not reported'],
      ['Cost', task.costMicros == null ? 'Unknown' : '$' + (task.costMicros / 1e6).toFixed(4)],
      ['Created', timestamp(task.createdAt)], ['Deadline', timestamp(task.deadline)],
      ['Failure reason', task.failureReason || '—'] ];
    facts.replaceChildren(element('dl', {}, rows.map(([label, value]) => [element('dt', {}, label), element('dd', {}, value)]).flat()));
    const children = allTasks().filter(child => child.parentId === id);
    paint(links, [id, task.parentId, task.dependencyIds, children.map(child => child.id)], () => [
      ...(task.parentId ? [taskLink('Parent', task.parentId)] : []),
      ...(task.dependencyIds || []).map(dependency => taskLink('Depends on', dependency)),
      ...children.map(child => taskLink('Child', child.id)),
    ]);
    if (actions.dataset.signature !== JSON.stringify([id, task.status, task.attempts, task.maxAttempts])) {
    actions.dataset.signature = JSON.stringify([id, task.status, task.attempts, task.maxAttempts]);
    actions.replaceChildren();
    if (working(task)) actions.append(element('button', { type: 'button', onclick: event => mutateTask(task, 'cancel', event.currentTarget) }, task.parentId ? 'Cancel task' : 'Cancel coordinator and children'));
    if (task.status === 'failed' && task.attempts < task.maxAttempts)
      actions.append(element('button', { type: 'button', onclick: event => mutateTask(task, 'retry', event.currentTarget) }, 'Retry task'));
    }
    const instruction = input?.submission?.prompt ?? (typeof input === 'string' ? input : null);
    paint(prompt, [id, task.promptRef], () => instruction ? element('details', {}, element('summary', {}, 'Task instruction'), element('pre', {}, instruction)) : []);
    if (result.dataset.signature !== JSON.stringify([id, task.outputRef, task.errorRef])) {
    result.dataset.signature = JSON.stringify([id, task.outputRef, task.errorRef]);
    result.replaceChildren();
    if (error) result.append(element('p', { class: 'message' }, typeof error.message === 'string' ? error.message : textOf(error)));
    if (output) {
      result.append(element('p', { class: 'fleet-verification' }, 'Verification · ' + (output.verification?.status || 'unknown')));
      for (const check of (output.verification?.checks || []).slice(0, 20)) result.append(element('details', {},
        element('summary', {}, check.status + ' · ' + (check.path || check.argv?.join(' ') || check.kind)),
        element('pre', {}, [check.stdout, check.stderr, check.error].filter(Boolean).join('\n').slice(0, 8000) || 'No output')));
      result.append(element('details', { open: true }, element('summary', {}, 'Result'), element('pre', {}, output.text || textOf(output))));
    }
    }
    if (approvals.dataset.signature !== JSON.stringify([id, pending.permissions])) {
    approvals.dataset.signature = JSON.stringify([id, pending.permissions]);
    approvals.replaceChildren();
    for (const permission of pending.permissions || []) {
      const box = element('div', { class: 'permission' }, element('h4', {}, permission.params?.toolCall?.title || 'Permission requested'));
      for (const option of permission.params?.options || []) box.append(element('button', { type: 'button', onclick: async event => {
        const button = event.currentTarget; button.disabled = true;
        try {
          await api('POST', '/tasks/' + encode(id) + '/permissions/' + encode(permission.requestId), { optionId: option.optionId });
          inform('Permission response accepted.'); await refresh();
        } catch (error) { showError(error); button.disabled = false; }
      } }, option.name));
      approvals.append(box);
    }
    }
    messageForm.hidden = false; await refreshMessages(id, projectId, generation);
  }
  function taskLink(label, id) {
    return element('button', { type: 'button', class: 'fleet-link', onclick: () => inspect(id).catch(showError) }, label + ' · ' + short(id));
  }
  async function mutateTask(task, action, button) {
    button.disabled = true;
    try { await api('POST', '/tasks/' + encode(task.id) + '/' + action); inform(action === 'retry' ? 'Retry queued.' : 'Cancellation recorded.'); await refresh(); }
    catch (error) { showError(error); button.disabled = false; }
  }
  async function refreshMessages(id, projectId, generation) {
    if (state.messageFor !== id) { state.messageFor = id; state.messagePages.clear(); }
    const offsets = state.messagePages.size ? [...state.messagePages.keys()] : [0];
    for (const offset of offsets.slice(0, 5)) {
      const page = await api('GET', '/messages?projectId=' + encode(projectId) + '&recipient=' + encode(id) + '&limit=50&offset=' + offset);
      if (state.selected !== id || state.project !== projectId || generation !== detailGeneration) return;
      state.messagePages.set(offset, page.messages);
      if (offset === Math.max(...state.messagePages.keys())) state.messageNext = page.nextOffset ?? null;
    }
    drawMessages();
  }
  function drawMessages() {
    const messages = [...state.messagePages.values()].flat();
    if (inbox.dataset.signature === JSON.stringify([state.selected, messages])) {
      moreMessages.hidden = state.messageNext === null || state.messagePages.size >= 5; return;
    }
    inbox.dataset.signature = JSON.stringify([state.selected, messages]);
    const position = inbox.scrollTop, atBottom = inbox.scrollHeight - position - inbox.clientHeight < 24;
    inbox.replaceChildren(...(messages.length ? messages.map(message => element('article', { class: 'fleet-message' },
      element('p', { class: 'muted' }, message.sender + ' · ' + timestamp(message.createdAt) +
        (message.acknowledgedAt ? ' · Acknowledged ' + timestamp(message.acknowledgedAt) : ' · No recorded acknowledgement')),
      element('p', {}, message.text))) : [element('p', { class: 'muted' }, 'No messages received by this task.')]));
    inbox.scrollTop = atBottom ? inbox.scrollHeight : position;
    moreMessages.hidden = state.messageNext === null || state.messagePages.size >= 5;
  }
  async function loadMoreMessages() {
    if (state.messageNext === null || state.messagePages.size >= 5) return;
    const id = state.selected, projectId = state.project, offset = state.messageNext;
    moreMessages.disabled = true;
    try {
      const page = await api('GET', '/messages?projectId=' + encode(projectId) + '&recipient=' + encode(id) + '&limit=50&offset=' + offset);
      if (state.selected !== id || state.project !== projectId) return;
      state.messagePages.set(offset, page.messages); state.messageNext = page.nextOffset ?? null; drawMessages();
    } finally { moreMessages.disabled = false; }
  }
  async function send() {
    const text = messageText.value.trim(), id = state.selected, projectId = state.project;
    if (!text || !id || sendMessage.disabled) return;
    sendMessage.disabled = true; messageText.disabled = true; messageRequestId ||= freshId('message');
    try {
      await api('POST', '/messages', { projectId, taskId: id, recipient: id, text, idempotencyKey: messageRequestId });
      if (state.selected === id && state.project === projectId) { messageText.value = ''; drafts.delete(projectId + ':' + id); messageRequestId = undefined; }
      inform('Message saved to the task inbox.'); await refresh();
    } finally { sendMessage.disabled = false; messageText.disabled = false; }
  }
  function buildComposer() {
    const panel = element('details', { class: 'fleet-composer' }, element('summary', {}, 'New task'));
    const instruction = element('textarea', { 'aria-label': 'New task instruction', placeholder: 'Describe one bounded task and its expected result…', rows: '3', maxlength: '128000', required: true });
    const route = element('select', { 'aria-label': 'New task route', 'data-fleet-route': '' });
    const dependencies = element('input', { 'aria-label': 'Prerequisite task IDs', placeholder: 'Comma-separated task IDs (optional)' });
    const minutes = element('input', { type: 'number', value: '5', min: '1', max: '30', required: true });
    const attempts = element('input', { type: 'number', value: '1', min: '1', max: '3', required: true });
    const paid = element('input', { type: 'checkbox', 'aria-label': 'Allow API billing for this task' });
    const estimate = element('input', { type: 'number', value: '0.1', min: '0', max: '100', step: '0.001' });
    const decision = element('input', { type: 'number', value: '0.001', min: '0', max: '0.05', step: '0.001' });
    const budgets = element('div', { class: 'fleet-budget-fields', hidden: true }, element('label', {}, 'Request estimate, USD', estimate),
      element('label', {}, 'Routing decision estimate, USD', decision), element('p', { class: 'muted' }, 'Admission estimates do not cap total CLI spending.'));
    paid.onchange = () => { budgets.hidden = !paid.checked; createRequestId = undefined; };
    const submit = element('button', { type: 'submit', class: 'primary' }, 'Queue task');
    const form = element('form', { class: 'fleet-new-form', onsubmit: async event => {
      event.preventDefault(); if (submit.disabled) return;
      const dependencyIds = dependencies.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean);
      if (dependencyIds.length > 32) { showError(Error('Choose at most 32 prerequisite tasks.')); return; }
      createRequestId ||= freshId('task'); submit.disabled = true;
      const projectId = state.project;
      try {
        const body = { id: createRequestId, projectId, prompt: instruction.value.trim(),
          route: route.value ? { mode: 'explicit', agentId: route.value } : { mode: 'auto' },
          dependencyIds, maxRuntimeMs: Number(minutes.value) * 60_000, maxAttempts: Number(attempts.value),
          allowPaidApi: paid.checked,
          ...(paid.checked ? { maxEstimatedUsd: Number(estimate.value), decisionBudgetUsd: Number(decision.value) } : {}) };
        for (const control of form.querySelectorAll('input,textarea,select')) control.disabled = true;
        const response = await api('POST', '/tasks', body);
        instruction.value = ''; dependencies.value = ''; createRequestId = undefined; panel.open = false;
        try {
          if (projectId === state.project) await inspect(response.task.id);
          await refresh(); inform('Task accepted.');
        } catch { inform('Task accepted: ' + response.task.id + '. Details are unavailable; inspect this ID to reconnect.'); }
      } catch (error) { showError(error); }
      finally { submit.disabled = false; for (const control of form.querySelectorAll('input,textarea,select')) control.disabled = false; }
    } }, instruction, element('div', { class: 'fleet-form-grid' },
      element('label', {}, 'Route', route), element('label', {}, 'Runtime limit, minutes', minutes),
      element('label', {}, 'Maximum attempts', attempts)), dependencies,
      element('label', { class: 'api-choice' }, paid, 'Allow API-key billing for this task'), budgets, submit);
    form.oninput = () => { createRequestId = undefined; };
    panel.append(form); return panel;
  }
  function updateRoutes() {
    const select = composer.querySelector('[data-fleet-route]'), current = select.value;
    const signature = JSON.stringify(getAgents().map(agent => [agent.name, agent.signedIn, agent.profile?.model]));
    if (select.dataset.signature === signature) return;
    select.replaceChildren(element('option', { value: '' }, 'Auto · subscription first'), ...getAgents().map(agent =>
      element('option', { value: agent.name, disabled: agent.signedIn === false }, agent.name +
        (agent.profile?.model ? ' · ' + agent.profile.model : '') + (agent.signedIn === null ? ' · status unknown' : ''))));
    if ([...select.options].some(option => option.value === current)) select.value = current;
    select.dataset.signature = signature;
  }
  return { refresh };
}
