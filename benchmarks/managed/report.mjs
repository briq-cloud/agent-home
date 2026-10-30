import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const money = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sum = (values) =>
  values.every(money) ? values.reduce((sum, value) => sum + value, 0) : null;

/** Public allowlist only. Never copy prompts, output, credentials, raw sessions,
 * private configuration/logs, request headers, or provider generation IDs. */
export function buildManagedReport(inputs, recordedAt = new Date().toISOString()) {
  const experiments = inputs.map(({ id, role, result, provenance, verifiedSetupCostUsd }) => {
    const trials = (result.trials ?? []).map((trial) => {
      const arm = result.arms.find((arm) => arm.id === trial.arm) ?? {};
      const records = trial.generations ?? [];
      const execution = records.filter((record) => record.kind === "execution");
      const identities = [
        ...new Set(
          execution.map((record) =>
            JSON.stringify({
              profile: record.profile ?? null,
              requested: record.model ?? null,
              canonical:
                result.profiles?.find((profile) => profile.model === record.model)?.canonical ??
                null,
              actual: record.actualModel ?? null,
              provider: record.provider ?? null,
            }),
          ),
        ),
      ].map(JSON.parse);
      const modelsPinned =
        execution.length > 0 &&
        identities.every(
          (identity) =>
            typeof identity.actual === "string" &&
            identity.actual === (identity.canonical ?? identity.requested),
        );
      const verificationTimedOut =
        trial.verification?.checks?.some((check) => check.timedOut === true) ?? false;
      const inconclusive =
        trial.phase !== "complete" ||
        !["succeeded", "failed"].includes(trial.taskStatus) ||
        !!trial.error ||
        !!trial.telemetryIncomplete ||
        verificationTimedOut;
      const observationsMissing = trial.phase !== "complete" || !trial.taskStatus || !!trial.error;
      const accepted =
        role !== "invalid-contract" &&
        !inconclusive &&
        trial.taskStatus === "succeeded" &&
        trial.grade?.pass === true;
      return {
        id: trial.id,
        fixture: trial.fixtureId,
        fixtureVersion: trial.fixtureVersion ?? null,
        fixtureSha256: trial.fixtureSha256 ?? null,
        arm: trial.arm,
        phase: trial.phase,
        taskStatus: trial.taskStatus ?? null,
        externalGradePass: trial.grade?.pass ?? null,
        verification: trial.verification?.status ?? "unavailable",
        verificationTimedOut,
        accepted,
        classification:
          role === "invalid-contract"
            ? "invalid-contract"
            : inconclusive
              ? "inconclusive"
              : accepted
                ? "accepted"
                : "rejected",
        issue: trial.error
          ? "benchmark-observation-or-execution-error"
          : trial.phase === "infrastructure-failed"
            ? "host-startup-failed"
            : null,
        featuresRequested: {
          auto: !!arm.auto,
          context: !!arm.context,
          memory: !!arm.memory,
          delegation: !!arm.delegation,
        },
        featuresExercised:
          role === "functional" || observationsMissing ? null : !!trial.featuresExercised,
        featureEvidence:
          role === "functional" || observationsMissing
            ? null
            : {
                curatedContextInjected: !!trial.featureEvidence?.context?.injected,
                currentMemoryInjected: !!trial.featureEvidence?.memory?.injected,
                chosenRouteDispatched: !!trial.featureEvidence?.auto?.dispatched,
                childAttempts: trial.featureEvidence?.delegation?.childAttempts ?? 0,
              },
        route: trial.route
          ? {
              profile: trial.route.cli,
              model: trial.route.model ?? null,
              source: trial.route.source,
              reason:
                trial.route.source === "default"
                  ? "default route: decision abstained or unavailable"
                  : null,
            }
          : null,
        modelIdentities: identities,
        modelsPinned,
        elapsedMs: trial.totalMs ?? null,
        accountingWaitMs: trial.accountingWaitMs ?? null,
        settledCostUsd: money(trial.costUsd) ? trial.costUsd : null,
        executionGenerations: execution.length,
        routingDecisions: records.filter((record) => record.kind === "routing").length,
        ...(role === "functional"
          ? {
              functionalPass: trial.functionalPass === true,
              functionalProof: {
                rootSucceeded: trial.functionalProof?.rootSucceeded === true,
                childSucceeded: trial.functionalProof?.childSucceeded === true,
                childAttempts: trial.functionalProof?.childAttempts ?? 0,
                rootModelPinned: trial.functionalProof?.rootModelPinned === true,
                childModelPinned: trial.functionalProof?.childModelPinned === true,
                distinctProviders: trial.functionalProof?.distinctProviders === true,
              },
              functionalTasks: (trial.taskTree ?? []).map((task) => ({
                role: task.parentId ? "child" : "root",
                status: task.status,
                attempts: task.attempts,
                requestedProfile: task.requestedRoute?.agentId ?? null,
                actualProfile: task.actualRoute?.cli ?? null,
                actualModel: task.actualRoute?.model ?? null,
              })),
            }
          : {}),
        comparisonEligible:
          ["original-corrected", "remaining-revised"].includes(role) &&
          accepted &&
          modelsPinned &&
          trial.graderUnchanged === true &&
          trial.featuresExercised === true &&
          money(trial.costUsd),
      };
    });
    return {
      id,
      role,
      protocol: result.protocol ?? null,
      budgetTargetUsd: result.budgetTargetUsd ?? null,
      settledCostUsd: money(verifiedSetupCostUsd)
        ? verifiedSetupCostUsd
        : money(result.totalCostUsd)
          ? result.totalCostUsd
          : null,
      costNote: money(verifiedSetupCostUsd)
        ? "Operator reconciliation verified no provider request before native setup failure."
        : "Settled generation ledger plus typed decision usage.cost; all attempts retained.",
      stopped: result.stopped ?? null,
      fixtureOffset: result.fixtureOffset ?? 0,
      sourceHashes: Object.fromEntries(
        Object.entries(result.sourceHashes ?? {}).filter(
          ([file, sha]) =>
            /^(?:[A-Za-z0-9_./-]+\.(?:mjs|ts))$/.test(file) && /^[a-f0-9]{64}$/.test(sha),
        ),
      ),
      provenance,
      trials,
    };
  });
  const valid = experiments
    .filter((experiment) => ["original-corrected", "remaining-revised"].includes(experiment.role))
    .flatMap((experiment) => experiment.trials);
  return {
    kind: "agent-home-managed-production-evaluation",
    recordedAt,
    protocol:
      "Two held-out repair fixtures; five discovery arms; real production /tasks, native Claude ACP, declared deterministic command/artifact acceptance. The second fixture is a separately revised transport experiment.",
    accounting: {
      settledManagedCostUsd: sum(experiments.map((experiment) => experiment.settledCostUsd)),
      invalidContractCostUsd: sum(
        experiments
          .filter((experiment) => experiment.role === "invalid-contract")
          .map((experiment) => experiment.settledCostUsd),
      ),
      inconclusiveCorrectedCostUsd: sum(
        valid
          .filter((trial) => trial.classification === "inconclusive")
          .map((trial) => trial.settledCostUsd),
      ),
      acceptedCorrectedTasks: valid.filter((trial) => trial.accepted).length,
      correctedModelAttempts: valid.filter((trial) => trial.executionGenerations > 0).length,
      targetPhaseBudgetUsd: 2,
      includesOtherBatchOrRetrievalExperiments: false,
    },
    findings: [
      "Exploratory per-case observations only. No causal, statistical, routing, memory or delegation improvement claim.",
      "Both Auto trials abstained and used the default Haiku route; this does not demonstrate routing benefit.",
      "Original invoice memory/delegation polling failed; external grader pass does not establish successful task completion or exercised features.",
      "Revised coalesced delegation used no child and its declared command timed out under the resource-constrained run; a later external check passed. Treat the outcome as inconclusive, not a model-quality failure.",
      "Curated context is an injection upper bound; a single accepted case does not establish retrieval improvement.",
      "Revised second-fixture transport, run order and provider cache state prevent a neutral pooled treatment comparison.",
      "All policy memory facts also exist in baseline workspace files. Gold/graders are outside workspaces; same-UID access is not an OS sandbox.",
      "The provider key stayed on the home; native API profiles received relay credentials only. No subscription prompt was used.",
    ],
    experiments,
  };
}

const escape = (value) =>
  String(value ?? "—").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
const usd = (value) => (money(value) ? `$${value.toFixed(5)}` : "unknown");
export function managedReportHtml(report) {
  const trials = report.experiments
    .filter((experiment) => ["original-corrected", "remaining-revised"].includes(experiment.role))
    .flatMap((experiment) =>
      experiment.trials.map((trial) => ({ ...trial, experiment: experiment.id })),
    );
  const rows = trials
    .map(
      (trial) =>
        `<tr><td>${escape(trial.fixture)}<br><small>${escape(trial.arm)}</small></td><td><b class="${trial.classification === "accepted" ? "ok" : "muted"}">${escape(trial.classification)}</b><br>task ${escape(trial.taskStatus ?? "unobserved")} · grader ${trial.externalGradePass ? "pass" : "fail"}${trial.verificationTimedOut ? "<br><small>declared command timed out</small>" : ""}</td><td>${escape(trial.route?.source ?? "unobserved")}<br><small>${escape(trial.route?.profile ?? "")}</small></td><td>${trial.featuresExercised === null ? "unobserved" : trial.featuresExercised ? "yes" : "no"}<br><small>${trial.featureEvidence ? `context ${trial.featureEvidence.curatedContextInjected ? "yes" : "no"} · memory ${trial.featureEvidence.currentMemoryInjected ? "yes" : "no"} · children ${trial.featureEvidence.childAttempts}` : "polling/startup failed"}</small></td><td>${trial.modelsPinned ? "exact frozen identity" : "unverified"}<br><small>${escape(trial.modelIdentities.map((identity) => identity.actual).join(", "))}</small></td><td>${trial.elapsedMs === null ? "—" : (trial.elapsedMs / 1000).toFixed(1) + " s"}</td><td>${usd(trial.settledCostUsd)}</td></tr>`,
    )
    .join("");
  const functional = report.experiments.find((experiment) => experiment.role === "functional");
  const probe = functional?.trials[0];
  const functionalSection = probe
    ? `<h2>Separate forced delegation functional check</h2><p><b>${probe.functionalPass ? "Passed" : "Not established"}</b> · ${usd(probe.settledCostUsd)} settled. This explicitly requested a Haiku coordinator and a DeepSeek child to produce two exact files through production spawn/wait/result tools. It measures transport and lifecycle functionality only; forced delegation is not an optimization, model ranking or savings comparison.</p><ul>${(probe.functionalTasks ?? []).map((task) => `<li>${escape(task.role)}: ${escape(task.status)}, ${task.attempts} attempt; profile ${escape(task.actualProfile)}, model ${escape(task.actualModel)}</li>`).join("")}${probe.modelIdentities.map((identity) => `<li>${escape(identity.profile)} settled at ${escape(identity.actual)} on ${escape(identity.provider)}</li>`).join("")}</ul>`
    : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Managed production evaluation · 30 October 2026</title><style>body{margin:0;background:#f5f5f1;color:#232b24;font:15px/1.5 system-ui,sans-serif}main{max-width:1220px;margin:auto;padding:34px 24px}h1{font-size:34px;line-height:1.15;letter-spacing:-1px}h2{font-size:21px;margin-top:28px}.lead{font-size:19px;max-width:90ch}.note{border-left:4px solid #8a6e34;background:#f2eddc;padding:15px 18px}.metrics{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0}.metrics b{display:block;font-size:26px}.metrics small,small,.muted{color:#657160}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px;background:#fffdf7}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d9dfd4;padding:11px}th{white-space:nowrap}.ok{color:#32613a}code{font-size:11px;overflow-wrap:anywhere}a{color:#32613a}li{margin:8px 0}footer{margin-top:28px;border-top:1px solid #d9dfd4;padding-top:16px;color:#657160;font-size:12px}@media(max-width:720px){main{padding:24px 14px}h1{font-size:28px}td,th{padding:7px}}</style><main><small>Measured production paths · 30 October 2026</small><h1>Managed task evidence, with the failures retained</h1><p class="lead">Real native CLI turns, durable tasks, typed routing and deterministic acceptance. These two exploratory repair cases do not establish an optimization benefit.</p><p class="note"><b>Read the boundaries:</b> both Auto choosers abstained. Two invoice arms lost polling and were cancelled during cleanup despite passing the external file checks. The remaining fixture ran separately after benchmark transport fixes. Completed attempts were never replayed.</p><div class="metrics"><div><b>${usd(report.accounting.settledManagedCostUsd)}</b><small>all managed experiments, settled</small></div><div><b>${usd(report.accounting.invalidContractCostUsd)}</b><small>invalid earlier contract, retained</small></div><div><b>${usd(report.accounting.inconclusiveCorrectedCostUsd)}</b><small>inconclusive corrected trials, retained</small></div><div><b>${report.accounting.acceptedCorrectedTasks}</b><small>observed accepted corrected tasks</small></div></div><h2>Per-case observations</h2><div class="scroll"><table><thead><tr><th>Fixture / arm</th><th>Outcome</th><th>Route</th><th>Requested features exercised</th><th>Settled model identity</th><th>Task elapsed</th><th>Total cost</th></tr></thead><tbody>${rows}</tbody></table></div>${functionalSection}<h2>Interpretation and limits</h2><ul>${report.findings.map((finding) => `<li>${escape(finding)}</li>`).join("")}</ul><h2>Private provenance, public hashes</h2><p>Raw results and ledgers remain private on the benchmark home. Only their SHA-256 identities and allowlisted measurements are published in the <a href="2026-10-30-managed-evaluation.json">compact JSON report</a>; configurations, logs, prompts, credentials and generation IDs are excluded.</p>${report.experiments.map((experiment) => `<p><b>${escape(experiment.id)}</b> · ${escape(experiment.role)} · ${usd(experiment.settledCostUsd)}<br><small>results SHA-256</small> <code>${escape(experiment.provenance?.resultsSha256)}</code><br><small>ledger SHA-256</small> <code>${escape(experiment.provenance?.ledgerSha256)}</code></p>`).join("")}<footer>Recorded ${escape(report.recordedAt)}. Dollar totals cover these managed experiments; other batch/retrieval measurements are separate. Admission targets are not hard provider spend caps. Native harness, model/backend and source snapshots are recorded per experiment.</footer></main></html>`;
}

export async function readReportInput(root, id, role, verifiedSetupCostUsd) {
  const bytes = await readFile(join(root, "results.json"));
  let ledger;
  try {
    ledger = await readFile(join(root, "meter.jsonl"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let reconciliation;
  if (verifiedSetupCostUsd !== undefined) {
    reconciliation = await readFile(join(root, "setup-failure-reconciliation.json"));
    const facts = JSON.parse(reconciliation);
    if (facts.paidModelAdmissions !== 0 || facts.paidCostUsd !== 0 || verifiedSetupCostUsd !== 0)
      throw Error("unverified setup cost override");
  }
  return {
    id,
    role,
    result: JSON.parse(bytes),
    verifiedSetupCostUsd,
    provenance: {
      resultsSha256: digest(bytes),
      ledgerSha256: ledger ? digest(ledger) : null,
      ...(reconciliation ? { setupReconciliationSha256: digest(reconciliation) } : {}),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.argv[2], "utf8"));
  const report = buildManagedReport(
    await Promise.all(
      config.inputs.map(({ root, id, role, verifiedSetupCostUsd }) =>
        readReportInput(root, id, role, verifiedSetupCostUsd),
      ),
    ),
  );
  await writeFile(config.outputJson, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await writeFile(config.outputHtml, managedReportHtml(report), { mode: 0o600 });
  console.log(JSON.stringify(report.accounting));
}
