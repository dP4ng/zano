import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultReasoningEffortForRuntime,
  isValidReasoningEffortForRuntime,
  reasoningEffortItemsForRuntime,
  runtimeSupportsReasoningEffort,
} from "./agent-runtime";

test("Claude Code exposes max effort without adding max to Codex", () => {
  assert.equal(runtimeSupportsReasoningEffort("claude"), true);
  assert.equal(defaultReasoningEffortForRuntime("claude"), "high");
  assert.equal(isValidReasoningEffortForRuntime("claude", "max"), true);

  assert.equal(runtimeSupportsReasoningEffort("codex"), true);
  assert.equal(defaultReasoningEffortForRuntime("codex"), "medium");
  assert.equal(isValidReasoningEffortForRuntime("codex", "max"), false);

  assert.deepEqual(
    reasoningEffortItemsForRuntime("claude").map((item) => item.value),
    ["low", "medium", "high", "xhigh", "max"]
  );
  assert.deepEqual(
    reasoningEffortItemsForRuntime("codex").map((item) => item.value),
    ["low", "medium", "high", "xhigh"]
  );
});
