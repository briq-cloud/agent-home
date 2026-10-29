import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export async function report(root, records, info) {
  const sum = (arm) => {
    const rs = records.filter((r) => r.arm === arm);
    return {
      runs: rs.length,
      passed: rs.filter((r) => r.grade.pass && !r.error).length,
      costUsd:
        !rs.length || rs.some((r) => r.costUsd === null)
          ? null
          : rs.reduce((n, r) => n + r.costUsd, 0),
      totalMs: rs.reduce((n, r) => n + r.totalMs, 0),
    };
  };
  const summary = {
    ...info,
    generatedAt: new Date().toISOString(),
    arms: { baseline: sum("baseline"), "context-pack": sum("context-pack") },
    records,
  };
  await writeFile(join(root, "results.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  const rows = records
    .map(
      (r) =>
        `<tr><td>${esc(r.taskId)}</td><td>${esc(r.arm)}</td><td>${r.grade.pass && !r.error ? "PASS" : "FAIL"}</td><td>${(r.totalMs / 1000).toFixed(2)} s</td><td>${r.costUsd === null ? "unknown" : "$" + r.costUsd.toFixed(6)}</td><td>${r.toolCalls ?? "—"}</td><td>${esc(r.error ?? r.grade.reason ?? "")}</td></tr>`,
    )
    .join("");
  await writeFile(
    join(root, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent home benchmark results</title><style>body{font:16px/1.6 system-ui;background:#f4f3ed;color:#20382d;max-width:1100px;margin:40px auto;padding:20px}h1{font-size:40px}table{width:100%;border-collapse:collapse;background:#fffef9}td,th{padding:12px;border-bottom:1px solid #d8dfd4;text-align:left}small{color:#52695b}pre{white-space:pre-wrap}section{overflow:auto}</style><h1>Agent home benchmark</h1><p>${esc(info.mode)} · ${esc(info.model ?? "mock")} · ${records.length}/${info.expectedRuns ?? 12} completed cases</p><p>Small discovery sample, one attempt per arm. The context arm uses curated source references: an upper bound on retrieval, not a measured production retrieval algorithm. Provider-cache state is uncontrolled; order alternates AB/BA.</p><section><table><tr><th>Task</th><th>Arm</th><th>Acceptance</th><th>Total time</th><th>Provider cost</th><th>Tool calls</th><th>Failure</th></tr>${rows}</table></section><h2>Totals</h2><pre>${esc(JSON.stringify(summary.arms, null, 2))}</pre><p>Task time includes setup, agent execution and deterministic grading. Post-turn generation billing reconciliation is recorded separately as accountingWaitMs and excluded from task time. Admission may wait for reserved budget near its limit. Missing costs remain unknown. Mock results only test plumbing. No general chat model judges were used.</p><p><a href="results.json">Raw results</a></p></html>`,
  );
  return summary;
}
