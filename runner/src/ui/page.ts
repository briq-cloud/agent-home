import { readFileSync } from 'node:fs';

/** Local assets only: the page makes no third-party requests for scripts, fonts or product icons. */
export const PAGE = readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
export const ASSETS = new Map<string, { type: string; body: Buffer }>();
for (const [file, type] of [
  ['home.js', 'text/javascript'],
  ['fleet.js', 'text/javascript'],
  ['extensions.js', 'text/javascript'],
  ['home.css', 'text/css'],
] as const)
  ASSETS.set(`/assets/${file}`, { type, body: readFileSync(new URL(`./web/${file}`, import.meta.url)) });
for (const name of [
  'claude',
  'openai',
  'githubcopilot',
  'cursor',
  'grok',
  'mistralai',
  'googlegemini',
  'openrouter',
  'deepseek',
  'alibabacloud',
  'kimi',
  'zai',
  'minimax',
])
  ASSETS.set(`/assets/icons/${name}.svg`, {
    type: 'image/svg+xml',
    body: readFileSync(new URL(`./icons/${name}.svg`, import.meta.url)),
  });
