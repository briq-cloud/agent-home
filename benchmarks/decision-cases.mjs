// Human policy labels, not empirical execution-quality or cost labels.
// The first half is for development; the second half is held out.
export const decisionCases = [
  ["Find the default connection timeout in current docs.", "lookup", "efficient"],
  ["Fix a reduce call that fails on empty arrays.", "change", "efficient"],
  ["Design a migration spanning six services with zero downtime.", "plan", "capable"],
  ["Which environment variable controls log level? Cite the file.", "lookup", "efficient"],
  ["Add a legacy alias to an option parser with documented precedence.", "change", "efficient"],
  ["Plan a safe replacement of the payment ledger and settlement flow.", "plan", "capable"],
  ["Trace how retryDelayMs reaches the retry helper in three files.", "lookup", "efficient"],
  ["Correct a retry loop off-by-one while preserving error identity.", "change", "efficient"],
  ["Plan independent workstreams for a compiler backend rewrite.", "plan", "capable"],
  ["Find the current storage cap; an old cache entry may be stale.", "lookup", "efficient"],
  ["Add one missing numeric validation branch and a regression test.", "change", "efficient"],
  ["Plan the rollout of a new distributed authorization model across regions.", "plan", "capable"],
  [
    "Read the release notes and return the minimum supported runtime version.",
    "lookup",
    "efficient",
  ],
  ["Fix a sorting comparator so equal elements retain their order.", "change", "efficient"],
  ["Plan a backward-compatible multi-repository protocol upgrade.", "plan", "capable"],
  ["Locate the function that normalizes incoming header names.", "lookup", "efficient"],
  ["Make one helper return an empty map for absent input.", "change", "efficient"],
  ["Plan how to split a monolith into independently deployable services.", "plan", "capable"],
  ["Find where cache expiration is configured, with a source citation.", "lookup", "efficient"],
  ["Implement a documented enum value in a two-file adapter.", "change", "efficient"],
  ["Plan a cross-team redesign of storage encryption and key rotation.", "plan", "capable"],
  ["Which of the current docs defines the upload size limit?", "lookup", "efficient"],
  [
    "Correct a single date-boundary check and preserve valid input behavior.",
    "change",
    "efficient",
  ],
  ["Plan a staged database engine migration with rollback and data validation.", "plan", "capable"],
].map(([text, kind, route], i) => ({
  id: `decision-${String(i + 1).padStart(2, "0")}`,
  split: i < 12 ? "development" : "held-out",
  text,
  expected: { kind, route },
}));

// A zero-cost control, not the product policy. Intentionally exposes easy-label ceilings.
export function rulesBaseline(text) {
  const kind = /^(find|which|read|trace|locate)\b/i.test(text)
    ? "lookup"
    : /^(plan|design)\b/i.test(text)
      ? "plan"
      : "change";
  return { kind, route: kind === "plan" ? "capable" : "efficient" };
}
