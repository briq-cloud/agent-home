import { edgeToken, withoutEdgeEnvironment } from './edge-auth.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createCloudManager } from './manager.mjs';
import { nativeConnections } from './native-connections.mjs';
import { publicOrigin, createOwnerAuth } from './cloud-auth.mjs';

// One public listener. Both native processes bind loopback and are supervised here.
export async function startManager(env = process.env, { centralRuntime, spawnProcess = spawn } = {}) {
  const role = env.T3_CLOUD_ROLE ?? 'central';
  if (!['central', 'standalone'].includes(role)) throw Error('Manager role must be central or standalone');
  const origin = publicOrigin(env.T3_CLOUD_PUBLIC_ORIGIN);
  createOwnerAuth({key:env.T3_CLOUD_OWNER_KEY,origin});
  if (role === 'central' && !/^[a-zA-Z0-9_-]{1,128}$/.test(env.T3_CLOUD_OWNER_ID ?? '')) throw Error('A stable owner identity is required');
  if (role === 'central' && edgeToken(env.T3_CLOUD_EDGE_TOKEN) === env.T3_CLOUD_OWNER_KEY) throw Error('Distinct private edge credential required');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || [3773,7681].includes(port)) throw Error('Invalid public port');
  const allocatorToken = randomBytes(32).toString('base64url');
  let runtime, connections, server;
  const children = [];
  const sockets = new Set();
  let stopping = false;
  async function close() {
    if (stopping) return; stopping = true;
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections(); server?.close(); connections?.close();
    for (const child of children) child.kill('SIGTERM');
    await runtime?.close?.();
  }
  try {
    if (role === 'central') {
      const factory = centralRuntime ?? (await import('./central-runtime.mjs')).createCentralRuntime;
      runtime = await factory(env);
    }
    connections = nativeConnections(withoutEdgeEnvironment(env));
    server = createCloudManager({ role, publicOrigin: origin, ownerKey: env.T3_CLOUD_OWNER_KEY,
      ownerId: env.T3_CLOUD_OWNER_ID, allocatorToken, connections, ...runtime });
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  const nativeEnv = { ...env, T3_CLOUD_ROLE: role };
  for (const key of Object.keys(nativeEnv)) if (key.startsWith('T3_CLOUD_')) delete nativeEnv[key];
  nativeEnv.T3_CLOUD_ROLE = role;
  if (role === 'central') {
    nativeEnv.T3_CLOUD_ALLOCATOR_URL = `http://127.0.0.1:${port}/_cloud/threads`;
    nativeEnv.T3_CLOUD_ALLOCATOR_TOKEN = allocatorToken;
  }
  function launch(command, args, childEnv) {
    const child = spawnProcess(command,args,{env:childEnv,cwd:env.T3_CWD,stdio:'ignore'});
    children.push(child);
    child.once('error',()=>{process.exitCode=1;void close();});
    child.once('exit',()=>{if(!stopping){process.exitCode=1;void close();}});
  }
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,env.T3_HOST ?? '0.0.0.0',resolve);});
    launch('/opt/t3/t3',['serve','--host','127.0.0.1','--port','3773','--base-dir',env.T3_STATE,'--no-browser',env.T3_CWD],nativeEnv);
    const terminalEnv=withoutEdgeEnvironment(env);delete terminalEnv.T3_CLOUD_OWNER_KEY;delete terminalEnv.T3_CLOUD_ALLOCATOR_TOKEN;
    launch('ttyd',['--interface','127.0.0.1','--port','7681','--base-path','/_cloud/terminal','--writable','tmux','new-session','-A','-s','t3-cloud'],terminalEnv);
    return {server,close};
  } catch(error) {await close();throw error;}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const manager=await startManager();
    process.once('SIGTERM',()=>void manager.close());process.once('SIGINT',()=>void manager.close());
  } catch { process.stderr.write('T3 Cloud startup failed: verify private runtime configuration\n');process.exitCode=1; }
}
