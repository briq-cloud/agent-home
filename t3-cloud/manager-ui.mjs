export function managerPage({ nonce, authorized, role }) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>T3 Cloud Connections</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:48rem;margin:3rem auto;padding:1rem;background:#101214;color:#eee}button,input,a{font:inherit;margin:.4rem;padding:.5rem}a{color:#9bd}pre{white-space:pre-wrap}section{border-top:1px solid #555;padding:1rem 0}input{max-width:90%}</style>
<h1>T3 Cloud Connections</h1><p>Manage native connections in this ${role === 'central' ? 'central' : 'standalone'} environment. T3 uses its own pairing.</p>
<div id="login" ${authorized ? 'hidden' : ''}><form id="owner"><label>Owner key <input id="key" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></div>
<main id="manage" ${authorized ? '' : 'hidden'}><button id="refresh">Refresh connections</button><button id="logout">Sign out of this page</button><pre id="status"></pre>
<section><h2>Codex</h2><p>Uses the central broker's existing Codex connection.</p><button id="codex-login">Connect Codex</button><button id="codex-cancel">Cancel sign-in</button><button id="codex-logout">Disconnect Codex</button></section>
<section><h2>Claude</h2><button id="claude-login">Connect Claude</button><button id="claude-cancel">Cancel sign-in</button><form id="claude-code"><label>Vendor authorization code <input id="code" autocomplete="off"></label><button>Submit to Claude CLI</button></form></section>
<section><h2>Briq CLI</h2><p>The CLI's browser sign-in is separate from MCP authorization. An injected MCP capability does not establish a CLI sign-in.</p><button id="briq-login">Open native Briq sign-in</button></section>
<section><h2>T3 and terminal</h2><button id="pair">Create a five-minute T3 pairing</button><a href="/_cloud/terminal/" target="_blank" rel="noreferrer">Open terminal</a><a href="/">Open T3</a></section>
</main><p id="message" role="status"></p><div id="vendor"></div>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);let loginId;
async function request(path,data){const response=await fetch('/_cloud/'+path,{method:data===undefined?'GET':'POST',credentials:'same-origin',headers:data===undefined?{}:{'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw Error(value.error||'Connection operation failed');return value;}
function display(value){el('vendor').replaceChildren();el('message').textContent=JSON.stringify(value);for(const field of ['verificationUrl','authUrl','url','pairUrl']){if(typeof value[field]!=='string')continue;try{const url=new URL(value[field]);if(url.protocol!=='https:'&&!(field==='pairUrl'&&url.origin===location.origin))continue;const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noreferrer';link.textContent=field==='pairUrl'?'Pair T3':'Continue in your browser';el('vendor').append(link);}catch{}}}
async function run(action){try{await action();}catch(error){el('message').textContent=error.message;}}
async function refresh(){const data=await request('connections');el('status').textContent=JSON.stringify(data,null,2);}
el('owner').onsubmit=event=>{event.preventDefault();const key=el('key').value;el('key').value='';run(async()=>{await request('login',{key});location.replace('/_cloud/');});};
el('refresh').onclick=()=>run(refresh);el('logout').onclick=()=>run(async()=>{await request('logout',{});location.replace('/_cloud/');});
el('codex-login').onclick=()=>run(async()=>{const value=await request('codex/login',{});loginId=value.loginId;display(value);});
el('codex-cancel').onclick=()=>run(async()=>{if(loginId)display(await request('codex/cancel',{loginId}));});
el('codex-logout').onclick=()=>run(async()=>{await request('codex/logout',{});await refresh();});
for(const kind of ['claude','briq'])el(kind+'-login').onclick=()=>run(async()=>display(await request(kind+'/login',{})));
el('claude-cancel').onclick=()=>run(async()=>display(await request('claude/cancel',{})));
el('claude-code').onsubmit=event=>{event.preventDefault();const code=el('code').value;el('code').value='';run(async()=>display(await request('claude/input',{code})));};
el('pair').onclick=()=>run(async()=>display(await request('pair',{})));
${authorized ? 'run(refresh);' : ''}
</script></html>`;
}
