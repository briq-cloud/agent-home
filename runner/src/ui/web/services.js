export function createHomeServices({ call, byId }) {
  async function request(method, path, body) {
    const result = await call(method, '/home-services' + path, body);
    if (!result.ok) throw Error(result.body.error || 'Service request failed');
    return result.body;
  }
  function render(state) {
    if (state.dsh) byId('dsh-service').textContent = state.dsh.enabled ?
      'DSH is available as an explicitly selected experimental ACP agent.' :
      state.dsh.installed ? 'DSH is installed. Its experimental ACP route needs explicit operator configuration.' : 'DSH is not installed in this image.';
  }
  function briq(state) {
    byId('briq-status').textContent = state.authenticated === true ? 'Briq CLI is connected.' :
      state.authenticated === false ? 'Briq CLI is signed out.' : 'Briq CLI connection could not be verified.';
    const login = state.login;
    byId('briq-login').disabled = state.authenticated === true || ['starting', 'waiting'].includes(login?.state);
    const link = byId('briq-login-open');
    link.hidden = !login?.url;
    if (login?.url) link.href = login.url;
    else link.removeAttribute('href');
    byId('briq-login-code').textContent = login?.code ? 'Approve only if Briq shows code ' + login.code + '.' :
      login?.state === 'starting' ? 'Starting browser sign-in. Check connection for the approval link.' :
      login?.state === 'failed' ? 'Sign-in ended. Retry or run briq login in the terminal.' : '';
  }
  byId('briq-check').onclick = async () => {
    byId('briq-check').disabled = true;
    try { briq(await request('GET', '/briq')); } catch (error) { byId('briq-status').textContent = error.message; }
    finally { byId('briq-check').disabled = false; }
  };
  byId('briq-login').onclick = async () => {
    byId('briq-login').disabled = true;
    try { briq({ authenticated: null, login: await request('POST', '/briq/login') }); }
    catch (error) { byId('briq-status').textContent = error.message; byId('briq-login').disabled = false; }
  };
  request('GET', '').then(render).catch((error) => { byId('dsh-service').textContent = error.message; });
}
