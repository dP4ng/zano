export type AgentRuntime = "claude" | "codex" | "kimi";
export type AgentReasoningEffort = "low" | "medium" | "high" | "xhigh";

export const RUNTIME_ITEMS: Array<{ value: AgentRuntime; label: string }> = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex CLI" },
  { value: "kimi", label: "Kimi CLI" },
];

export const MODEL_ITEMS_BY_RUNTIME: Record<
  AgentRuntime,
  Array<{ value: string; label: string }>
> = {
  claude: [
    { value: "opus", label: "Opus — Most capable" },
    { value: "sonnet", label: "Sonnet — Balanced" },
    { value: "haiku", label: "Haiku — Fastest" },
  ],
  codex: [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  ],
  kimi: [{ value: "default", label: "Configured default" }],
};

export const REASONING_EFFORT_ITEMS: Array<{
  value: AgentReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

export function normalizeAgentRuntime(value: unknown): AgentRuntime {
  return value === "codex" || value === "kimi" || value === "claude"
    ? value
    : "claude";
}

export function defaultModelForRuntime(runtime: AgentRuntime): string {
  return MODEL_ITEMS_BY_RUNTIME[runtime][0].value;
}

export function runtimeSupportsModelSelection(runtime: AgentRuntime): boolean {
  return runtime !== "kimi";
}

export function runtimeSupportsReasoningEffort(runtime: AgentRuntime): boolean {
  return runtime === "codex";
}

export function defaultReasoningEffortForRuntime(
  runtime: AgentRuntime
): AgentReasoningEffort | null {
  return runtimeSupportsReasoningEffort(runtime) ? "medium" : null;
}

export function isValidModelForRuntime(
  runtime: AgentRuntime,
  model: unknown
): model is string {
  if (typeof model !== "string" || !model.trim()) return false;
  if (runtime === "claude") {
    return MODEL_ITEMS_BY_RUNTIME.claude.some((item) => item.value === model);
  }
  if (runtime === "kimi") {
    return model === "default";
  }
  return true;
}

export function isValidReasoningEffortForRuntime(
  runtime: AgentRuntime,
  value: unknown
): value is AgentReasoningEffort {
  return (
    runtimeSupportsReasoningEffort(runtime) &&
    typeof value === "string" &&
    REASONING_EFFORT_ITEMS.some((item) => item.value === value)
  );
}
