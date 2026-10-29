import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tasks, prepare, contextPack } from "./fixtures.mjs";
import { promptAcp } from "./acp.mjs";
const exec = promisify(execFile);
export default class BenchmarkProvider {
  #runtime;
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.#runtime = options.runtime ?? {};
  }
  id() {
    return `agent-home:${this.config.arm ?? "baseline"}`;
  }
  async callApi(_prompt, context) {
    const started = performance.now(),
      task = tasks.find((t) => t.id === context.vars.taskId),
      arm = context.vars.arm ?? this.config.arm ?? "baseline";
    if (!task || !["baseline", "context-pack"].includes(arm)) throw Error("invalid-benchmark-case");
    const root = resolve(this.config.root ?? "results/work");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(root, `${task.id}-${arm}-`));
    await prepare(workspace, task);
    let pack = null,
      prompt = `Work only inside ${workspace}. Do not access credentials, other folders or the network.\n${task.prompt}`;
    if (arm === "context-pack") {
      pack = await contextPack(workspace, task);
      prompt += `\n\nSource context (${pack.selection}):\n${pack.text}`;
    }
    const setupMs = performance.now() - started;
    await this.#runtime.begin?.({ taskId: task.id, arm });
    let gradingStarted = false;
    let result,
      error = null,
      grade = { pass: false, reason: "not-completed" };
    try {
      result = await promptAcp({
        url: this.#runtime.url,
        token: this.#runtime.token,
        cwd: workspace,
        prompt,
        timeoutMs: this.config.timeoutMs ?? 90000,
        allowTools: this.config.allowTools === true,
      });
      const answerFile = workspace + ".answer";
      await writeFile(answerFile, result.output, { mode: 0o600 });
      gradingStarted = true;
      const checked = await exec(
        process.execPath,
        [
          fileURLToPath(new URL("./grade-worker.mjs", import.meta.url)),
          workspace,
          task.id,
          answerFile,
        ],
        { timeout: 5000, maxBuffer: 64000 },
      );
      grade = JSON.parse(checked.stdout);
      if (result.stopReason !== "end_turn")
        grade = { pass: false, reason: `stop-${result.stopReason}` };
    } catch (e) {
      result ??= e.benchmarkPartial;
      if (gradingStarted)
        grade = {
          pass: false,
          reason: e.killed ? "acceptance-check-timeout" : "acceptance-check-error",
        };
      else
        error =
          e.message === "trial-timeout"
            ? "timeout"
            : /exceeded.*output token|output.*maximum/i.test(result?.output ?? "")
              ? "output-limit"
              : "execution-or-grader-error";
    }
    const totalMs = performance.now() - started;
    const accountingStarted = performance.now();
    const billing = (await this.#runtime.end?.()) ?? { costUsd: null, provenance: "unavailable" };
    const record = {
      taskId: task.id,
      fixtureSha256: createHash("sha256")
        .update(
          JSON.stringify({ id: task.id, prompt: task.prompt, files: task.files, refs: task.refs }),
        )
        .digest("hex"),
      arm,
      grade,
      error,
      setupMs,
      totalMs,
      accountingWaitMs: performance.now() - accountingStarted,
      context: pack
        ? {
            cacheState: pack.cacheState,
            selection: pack.selection,
            bytes: Buffer.byteLength(pack.text),
          }
        : null,
      ...result,
      ...billing,
    };
    await writeFile(workspace + ".result.json", JSON.stringify(record, null, 2), { mode: 0o600 });
    return {
      output: JSON.stringify({ taskId: task.id, arm, grade, error }),
      ...(billing.costUsd !== null ? { cost: billing.costUsd } : {}),
      metadata: record,
      cached: false,
    };
  }
}
