import WebSocket from 'ws';
import { createInterface } from 'node:readline';

if (process.argv.slice(2).join(' ') === '--version') {
  process.stdout.write('codex-cli 0.166.0\n');
} else {
  if (process.argv.slice(2).join(' ') !== 'app-server') throw Error('Only scoped app-server transport is available');
  const url = new URL(process.env.T3_CLOUD_BRIDGE_URL);
  const token = process.env.T3_CLOUD_BRIDGE_TOKEN;
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || !token || token.length < 32)
    throw Error('Missing sandbox bridge capability');
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, maxPayload: 2097152,
    perMessageDeflate: false, handshakeTimeout: 15000 });
  let opened = false; const queued = [];
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (line.length > 2097152) return socket.close();
    try { JSON.parse(line); } catch { return socket.close(); }
    if (opened) socket.send(line);
    else if (queued.length < 32) queued.push(line); else socket.close();
  });
  socket.once('open', () => { opened = true; for (const line of queued) socket.send(line); queued.length = 0; });
  socket.on('message', data => { process.stdout.write(`${data}\n`); });
  socket.on('error', () => { process.stderr.write('Sandbox bridge unavailable\n'); process.exitCode = 1; });
  socket.on('close', () => { input.close(); process.stdin.destroy(); });
  input.once('close', () => socket.close());
}
