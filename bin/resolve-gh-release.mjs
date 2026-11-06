#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the version and exact asset digest together; never publish partial outputs.
export async function resolveRelease(repo, prefix, asset, { fetchRelease = fetch, token, version: requestedVersion } = {}) {
  if (!/^[\w-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid release repository');
  if (requestedVersion !== undefined && !/^\d+\.\d+\.\d+(?:[.+-][\w.-]+)?$/.test(requestedVersion))
    throw new Error('Invalid requested release version');
  const release = requestedVersion === undefined ? 'latest' : `tags/${encodeURIComponent(prefix + requestedVersion)}`;
  let metadata;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchRelease(`https://api.github.com/repos/${repo}/releases/${release}`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if ([502, 503, 504].includes(response.status) && attempt < 2) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
    try { metadata = await response.json(); }
    catch { throw new Error('Invalid GitHub release metadata'); }
    break;
  }
  const version = typeof metadata?.tag_name === 'string' && metadata.tag_name.startsWith(prefix)
    ? metadata.tag_name.slice(prefix.length) : '';
  if (requestedVersion !== undefined && version !== requestedVersion)
    throw new Error('GitHub release does not match the requested version');
  const matches = Array.isArray(metadata?.assets) ? metadata.assets.filter((item) => item.name === asset) : [];
  const digest = matches.length === 1 ? matches[0].digest : '';
  if (!/^\d+\.\d+\.\d+(?:[.+-][\w.-]+)?$/.test(version) || !/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error('Release requires a valid version and one exact asset with a SHA-256 digest');
  return `${version}\t${digest.slice(7)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required for release resolution');
    console.log(await resolveRelease(...process.argv.slice(2, 5), { token: process.env.GH_TOKEN, version: process.argv[5] }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
