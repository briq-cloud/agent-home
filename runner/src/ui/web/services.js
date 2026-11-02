export function createHomeServices({ call, byId }) {
  let pairingExpiry;
  async function request(method, path, body) {
    const result = await call(method, '/home-services' + path, body);
    if (!result.ok) throw Error(result.body.error || 'Service request failed');
    return result.body;
  }
  function render(state) {
    const t3 = state.t3;
    byId('t3-openrouter').checked = t3.optinOpenRouter === true;
    byId('t3-status').textContent = !t3.installed ? 'T3 Code is not installed in this image.' :
      t3.state === 'running' ? 'T3 Code process is running. Pair your browser to connect.' :
      t3.state === 'failed' ? 'T3 Code stopped unexpectedly. Start it again to retry.' : 'T3 Code is stopped.';
    byId('t3-start').disabled = !t3.installed || t3.state === 'running';
    byId('t3-pair').disabled = t3.state !== 'running' || !t3.publicUrl;
    if (!t3.publicUrl) byId('t3-notice').textContent = 'Browser access needs a dedicated T3 origin configured by this home’s operator.';
    if (state.dsh) byId('dsh-service').textContent = state.dsh.enabled ?
      'DSH is available as an explicitly selected experimental ACP agent.' :
      state.dsh.installed ? 'DSH is installed. Its experimental ACP route needs explicit operator configuration.' : 'DSH is not installed in this image.';
  }
  const failure = (error) => { byId('t3-notice').textContent = error.message; };
  const refresh = () => request('GET', '').then(render).catch(failure);
  byId('services-refresh').onclick = refresh;
  byId('t3-openrouter').onchange = async () => {
    const choice = byId('t3-openrouter');
    choice.disabled = true;
    try { render(await request('PUT', '/t3/routing', { optinOpenRouter: choice.checked })); }
    catch (error) { choice.checked = !choice.checked; failure(error); }
    finally { choice.disabled = false; }
  };
  byId('t3-start').onclick = async () => {
    byId('t3-start').disabled = true;
    try { render(await request('POST', '/t3')); } catch (error) { failure(error); byId('t3-start').disabled = false; }
  };
  byId('t3-pair').onclick = async () => {
    byId('t3-pair').disabled = true;
    try {
      const result = await request('POST', '/t3/pair');
      const link = byId('t3-open');
      link.href = result.url; link.hidden = false;
      byId('t3-notice').textContent = 'Private, one-use browser link ready. Expires ' + new Date(result.expiresAt).toLocaleTimeString() + '.';
      clearTimeout(pairingExpiry);
      pairingExpiry = setTimeout(() => { link.hidden = true; link.removeAttribute('href'); }, Math.max(0, Date.parse(result.expiresAt) - Date.now()));
    } catch (error) { failure(error); }
    finally { byId('t3-pair').disabled = false; }
  };
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
  refresh();
}
