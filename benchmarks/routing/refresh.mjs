import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeCatalog, fresh } from "./policy.mjs";
export async function refresh(path, { fetcher = fetch, now = Date.now() } = {}) {
  let previous;
  try {
    previous = JSON.parse(await readFile(path, "utf8"));
  } catch {}
  if (previous && fresh(previous.fetchedAt, now)) return { ...previous, refresh: "cached" };
  try {
    const response = await fetcher("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error(`catalog HTTP ${response.status}`);
    const catalog = normalizeCatalog(await response.json(), new Date(now).toISOString());
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path + ".tmp", JSON.stringify(catalog, null, 2), { mode: 0o600 });
    await rename(path + ".tmp", path);
    return { ...catalog, refresh: "updated" };
  } catch {
    if (previous)
      return { ...previous, refresh: "failed; last good retained; stale catalog cannot route" };
    throw Error("catalog refresh failed; no last good snapshot");
  }
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const c = await refresh(resolve(process.argv[2] ?? "results/model-catalog.json"));
  console.log(
    JSON.stringify({ models: c.models.length, fetchedAt: c.fetchedAt, refresh: c.refresh }),
  );
}
