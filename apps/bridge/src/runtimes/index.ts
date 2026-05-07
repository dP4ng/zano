import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeId = "claude" | "codex" | "kimi";

export interface RuntimeLaunchContext {
  agentId: string;
  displayName: string;
  workDir: string;
  systemPrompt: string;
  model: string;
  sessionId: string | null;
  zanoDir: string;
  env: NodeJS.ProcessEnv;
}

export interface RuntimeLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  initialInput: string[];
  sessionId: string | null;
}

export type ParsedRuntimeEvent =
  | { type: "session_init"; sessionId: string }
  | { type: "turn_started"; turnId: string }
  | { type: "thinking"; text?: string }
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      name: string;
      input?: Record<string, unknown>;
      label?: string;
      detail?: string;
    }
  | { type: "compaction_started" }
  | { type: "compaction_finished" }
  | { type: "turn_end"; sessionId?: string }
  | { type: "error"; message: string };

export interface EncodeMessageContext {
  userMessage: string;
  sessionId: string | null;
  turnId: string | null;
  busy: boolean;
}

export interface RuntimeDriver {
  id: RuntimeId;
  displayName: string;
  defaultModel: string;
  supportsSteer: boolean;
  requiresSessionBeforeInput: boolean;
  buildLaunch(ctx: RuntimeLaunchContext): RuntimeLaunch;
  encodeUserMessage(ctx: EncodeMessageContext): string | null;
  parseLine(line: string): ParsedRuntimeEvent[];
}

const RUNTIME_IDS = new Set<RuntimeId>(["claude", "codex", "kimi"]);
let rpcId = 0;

export function normalizeRuntime(value: unknown): RuntimeId {
  return typeof value === "string" && RUNTIME_IDS.has(value as RuntimeId)
    ? (value as RuntimeId)
    : "claude";
}

export function defaultModelForRuntime(runtime: RuntimeId): string {
  return getRuntimeDriver(runtime).defaultModel;
}

export function isKnownModelForRuntime(runtime: RuntimeId, model: unknown): model is string {
  if (typeof model !== "string" || !model.trim()) return false;
  if (runtime === "claude") return ["opus", "sonnet", "haiku"].includes(model);
  if (runtime === "kimi") return true;
  return true;
}

export function getRuntimeDriver(runtime: RuntimeId): RuntimeDriver {
  switch (runtime) {
    case "codex":
      return codexDriver;
    case "kimi":
      return kimiDriver;
    case "claude":
    default:
      return claudeDriver;
  }
}

function request(method: string, params: unknown, id?: string | number): string {
  const requestId = id ?? ++rpcId;
  return JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params });
}

function parseJson(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function withClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CLAUDECODE;
  return next;
}

const claudeDriver: RuntimeDriver = {
  id: "claude",
  displayName: "Claude Code",
  defaultModel: "opus",
  supportsSteer: false,
  requiresSessionBeforeInput: false,

  buildLaunch(ctx) {
    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      ctx.systemPrompt,
      "--permission-mode",
      "bypassPermissions",
      "--model",
      ctx.model,
    ];

    if (ctx.sessionId) {
      args.push("--resume", ctx.sessionId);
    }

    return {
      command: "claude",
      args,
      cwd: ctx.workDir,
      env: withClaudeEnv(ctx.env),
      initialInput: [],
      sessionId: ctx.sessionId,
    };
  },

  encodeUserMessage(ctx) {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: ctx.userMessage }],
      },
      ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
    });
  },

  parseLine(line) {
    const event = parseJson(line);
    if (!event) return [];

    if (event.type === "system") {
      if (event.subtype === "init" && event.session_id) {
        return [{ type: "session_init", sessionId: event.session_id }];
      }
      if (event.subtype === "compacting") {
        return [{ type: "compaction_started" }];
      }
      return [];
    }

    if (event.type === "assistant") {
      const contentBlock = event.message?.content?.[0];
      if (!contentBlock) return [];

      if (contentBlock.type === "thinking") {
        return [{ type: "thinking" }];
      }
      if (contentBlock.type === "text") {
        return [{ type: "text", text: contentBlock.text || "" }];
      }
      if (contentBlock.type === "tool_use") {
        return [
          {
            type: "tool_call",
            name: contentBlock.name || "tool",
            input: contentBlock.input || {},
          },
        ];
      }
      return [];
    }

    if (event.type === "result") {
      return [{ type: "turn_end", sessionId: event.session_id }];
    }

    return [];
  },
};

const codexDriver: RuntimeDriver = {
  id: "codex",
  displayName: "Codex CLI",
  defaultModel: "gpt-5.5",
  supportsSteer: true,
  requiresSessionBeforeInput: true,

  buildLaunch(ctx) {
    ensureGitRepository(ctx.workDir);

    const env = { ...ctx.env, FORCE_COLOR: "0", NO_COLOR: "1" };
    const threadParams = {
      ...(ctx.sessionId ? { threadId: ctx.sessionId } : {}),
      cwd: ctx.workDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: ctx.systemPrompt,
      ...(ctx.model ? { model: ctx.model } : {}),
    };

    return {
      command: "codex",
      args: [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'shell_environment_policy.inherit="all"',
      ],
      cwd: ctx.workDir,
      env,
      initialInput: [
        request("initialize", {
          clientInfo: { name: "zano-bridge", title: "Zano Bridge", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        }),
        request(ctx.sessionId ? "thread/resume" : "thread/start", threadParams),
      ],
      sessionId: ctx.sessionId,
    };
  },

  encodeUserMessage(ctx) {
    if (!ctx.sessionId) return null;

    if (ctx.busy) {
      if (!ctx.turnId) return null;
      return request("turn/steer", {
        threadId: ctx.sessionId,
        input: textInput(ctx.userMessage),
        expectedTurnId: ctx.turnId,
      });
    }

    return request("turn/start", {
      threadId: ctx.sessionId,
      input: textInput(ctx.userMessage),
    });
  },

	  parseLine(line) {
	    const msg = parseJson(line);
	    if (!msg) return [];

    if (msg.error) {
      return [{ type: "error", message: msg.error.message || "Codex runtime error" }];
    }

    if (msg.result?.thread?.id) {
      return [{ type: "session_init", sessionId: msg.result.thread.id }];
    }

    const method = msg.method;
    const params = msg.params || {};
    if (!method) return [];

    switch (method) {
      case "thread/started":
        return params.thread?.id ? [{ type: "session_init", sessionId: params.thread.id }] : [];

      case "turn/started":
        return params.turn?.id ? [{ type: "turn_started", turnId: params.turn.id }] : [];

      case "item/agentMessage/delta":
        return [{ type: "text", text: params.delta || "" }];

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return [{ type: "thinking", text: params.delta || "" }];

      case "item/started":
        return describeCodexItem(params.item);

      case "item/completed":
        if (params.item?.type === "contextCompaction") {
          return [{ type: "compaction_finished" }];
        }
        return [];

      case "thread/compacted":
        return [{ type: "compaction_finished" }];

      case "turn/completed":
        return [{ type: "turn_end" }];

      case "error":
        return [{ type: "error", message: params.message || "Codex runtime error" }];

      default:
        return [];
    }
  },
};

function ensureGitRepository(workDir: string) {
  if (!existsSync(workDir)) return;

  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workDir,
      stdio: "ignore",
    });
    return;
  } catch {
    // Initialize below.
  }

  try {
    execFileSync("git", ["init"], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "zano-agent@example.local"], {
      cwd: workDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Zano Agent"], {
      cwd: workDir,
      stdio: "ignore",
    });
    execFileSync("git", ["commit", "--allow-empty", "-m", "Initial commit"], {
      cwd: workDir,
      stdio: "ignore",
    });
  } catch {
    // Codex can still attempt to start; surface any runtime failure normally.
  }
}

function describeCodexItem(item: any): ParsedRuntimeEvent[] {
  if (!item) return [];

  if (item.type === "contextCompaction") {
    return [{ type: "compaction_started" }];
  }

  if (item.type === "commandExecution") {
    return [
      {
        type: "tool_call",
        name: "Bash",
        input: { command: item.command || "" },
      },
    ];
  }

  if (item.type === "fileChange") {
    return [
      {
        type: "tool_call",
        name: "Edit",
        label: "Editing files",
        detail: "",
      },
    ];
  }

  if (item.type === "mcpToolCall") {
    return [
      {
        type: "tool_call",
        name: item.tool || "mcp",
        label: `Running ${item.tool || "MCP tool"}`,
        detail: item.server || "",
      },
    ];
  }

  return [];
}

const kimiDriver: RuntimeDriver = {
  id: "kimi",
  displayName: "Kimi CLI",
  defaultModel: "default",
  supportsSteer: true,
  requiresSessionBeforeInput: false,

  buildLaunch(ctx) {
    if (!existsSync(ctx.zanoDir)) {
      mkdirSync(ctx.zanoDir, { recursive: true });
    }

    const sessionId = ctx.sessionId || randomUUID();
    const systemPromptPath = join(ctx.zanoDir, "kimi-system.md");
    const agentFilePath = join(ctx.zanoDir, "kimi-agent.yaml");
    const mcpConfigPath = join(ctx.zanoDir, "kimi-mcp.json");

    writeFileSync(systemPromptPath, ctx.systemPrompt);
    writeFileSync(
      agentFilePath,
      [
        "version: 1",
        "agent:",
        "  extend: default",
        `  system_prompt_path: ${JSON.stringify(systemPromptPath)}`,
        "",
      ].join("\n")
    );
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }, null, 2));

    const args = [
      "--wire",
      "--yolo",
      "--agent-file",
      agentFilePath,
      "--mcp-config-file",
      mcpConfigPath,
      "--session",
      sessionId,
    ];
    if (ctx.model && ctx.model !== "default") {
      args.push("--model", ctx.model);
    }

    return {
      command: "kimi",
      args,
      cwd: ctx.workDir,
      env: { ...ctx.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      initialInput: [
        request("initialize", {
          protocol_version: "1.9",
          client: { name: "zano-bridge", version: "0.1.0" },
          capabilities: {
            supports_question: false,
            supports_plan_mode: false,
          },
        }, randomUUID()),
      ],
      sessionId,
    };
  },

  encodeUserMessage(ctx) {
    return request(
      ctx.busy ? "steer" : "prompt",
      { user_input: ctx.userMessage },
      randomUUID()
    );
  },

  parseLine(line) {
    const msg = parseJson(line);
    if (!msg) return [];

    if (msg.error) {
      return [{ type: "error", message: msg.error.message || "Kimi runtime error" }];
    }

    if (msg.method !== "event") return [];

    const params = msg.params || {};
    switch (params.type) {
      case "StepBegin":
        return [{ type: "thinking" }];

      case "ContentPart": {
        const payload = params.payload && typeof params.payload === "object"
          ? params.payload
          : params;
        const part = payload.part && typeof payload.part === "object"
          ? payload.part
          : {};
        const payloadType = payload === params ? undefined : payload.type;
        const partType =
          payloadType ||
          payload.content_type ||
          payload.contentType ||
          part.type ||
          payload.part_type;
        const text =
          payload.text ||
          payload.think ||
          payload.content ||
          part.text ||
          "";
        return partType === "think" || partType === "thinking"
          ? [{ type: "thinking", text }]
          : [{ type: "text", text }];
      }

      case "ToolCall":
        return [
          {
            type: "tool_call",
            name: params.name || params.tool_name || params.tool || "tool",
            input: params.arguments || params.args || {},
          },
        ];

      case "CompactionBegin":
        return [{ type: "compaction_started" }];

      case "CompactionEnd":
        return [{ type: "compaction_finished" }];

      case "TurnEnd":
      case "StepInterrupted":
        return [{ type: "turn_end" }];

      default:
        return [];
    }
  },
};
