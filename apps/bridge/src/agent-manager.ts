import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import { spawn, ChildProcess } from "child_process";
import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadLocalRuntimeEnv } from "./runtime-env.js";
import {
  defaultModelForRuntime,
  defaultReasoningEffortForRuntime,
  getRuntimeDriver,
  isKnownModelForRuntime,
  isKnownReasoningEffortForRuntime,
  normalizeRuntime,
  type ParsedRuntimeEvent,
  type RuntimeDriver,
  type RuntimeId,
} from "./runtimes/index.js";

type AgentActivity = "idle" | "thinking" | "working" | "error";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ACTIVITY_HEARTBEAT_MS = 60_000; // Re-broadcast active state every 60s

interface AgentRecord {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  runtime?: string | null;
  model: string | null;
  reasoning_effort?: string | null;
  status: string;
}

interface AgentSession {
  id: string;
  name: string;
  displayName: string;
  workDir: string;
}

interface QueuedMessage {
  userMessage: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface AgentProcess {
  proc: ChildProcess;
  driver: RuntimeDriver;
  runtime: RuntimeId;
  sessionId: string | null;
  currentTurnId: string | null;
  busy: boolean;
  stdoutBuffer: string;
  activity: AgentActivity;
  activityLabel: string;
  activityDetail: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  messageQueue: QueuedMessage[];
  /** Accumulated text content from assistant text events */
  pendingText: string;
}

interface CliTransport {
  zanoDir: string;
  tokenFilePath: string | null;
}

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private processes = new Map<string, AgentProcess>();
  private agentsDir: string;
  private supabase: SupabaseClient;
  private supabaseUrl: string;
  private supabaseKey: string;
  private authToken: string;
  private serverId: string;
  private activityChannel: RealtimeChannel;

  constructor(
    agentsDir: string,
    supabase: SupabaseClient,
    supabaseUrl: string,
    supabaseKey: string,
    authToken: string = "",
    serverId: string = ""
  ) {
    this.agentsDir = agentsDir;
    this.supabase = supabase;
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.authToken = authToken;
    this.serverId = serverId;

    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }

    // Set up Realtime Broadcast channel for agent activity
    this.activityChannel = this.supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });
    this.activityChannel.subscribe();
  }

  /** Update the Supabase client and auth token (called on token refresh) */
  updateSupabaseClient(supabase: SupabaseClient, authToken: string) {
    // Remove old activity channel
    this.supabase.removeChannel(this.activityChannel);

    this.supabase = supabase;
    this.authToken = authToken;

    // Re-subscribe activity channel on new client
    this.activityChannel = this.supabase.channel("agent-activity", {
      config: { broadcast: { self: false } },
    });
    this.activityChannel.subscribe();
  }

  /** Broadcast agent activity to all connected frontend clients */
  private broadcastActivity(
    agentId: string,
    activity: AgentActivity,
    label: string = "",
    detail: string = ""
  ) {
    const agentProc = this.processes.get(agentId);
    if (agentProc) {
      agentProc.activity = activity;
      agentProc.activityLabel = label;
      agentProc.activityDetail = detail;

      // Manage heartbeat: only active for thinking/working
      if (activity === "thinking" || activity === "working") {
        if (!agentProc.heartbeatTimer) {
          agentProc.heartbeatTimer = setInterval(() => {
            this.activityChannel.send({
              type: "broadcast",
              event: "activity",
              payload: {
                agentId,
                activity: agentProc.activity,
                label: agentProc.activityLabel,
                detail: agentProc.activityDetail,
              },
            });
          }, ACTIVITY_HEARTBEAT_MS);
        }
      } else {
        if (agentProc.heartbeatTimer) {
          clearInterval(agentProc.heartbeatTimer);
          agentProc.heartbeatTimer = null;
        }
      }
    }

    this.activityChannel.send({
      type: "broadcast",
      event: "activity",
      payload: { agentId, activity, label, detail },
    });
  }

  /**
   * Map a tool_use event to a human-readable label and detail string.
   * e.g. Read → ("Reading file", "/path/to/file")
   */
  private describeToolUse(contentBlock: any): { label: string; detail: string } {
    const toolName: string = contentBlock.name || "tool";
    const input = contentBlock.input || {};

    switch (toolName) {
      case "Read":
        return { label: "Reading file", detail: input.file_path || "" };

      case "Write":
        return { label: "Writing file", detail: input.file_path || "" };

      case "Edit":
        return { label: "Editing file", detail: input.file_path || "" };

      case "Bash": {
        const cmd: string = input.command || "";
        // Detect zano/slock message send
        const msgMatch = cmd.match(/(?:zano|slock)\s+message\s+send\s+--target\s+"?([^"]+)"?/);
        if (msgMatch) {
          return { label: "Sending message", detail: msgMatch[1] };
        }
        // Truncate long commands
        return { label: "Running command", detail: cmd.length > 120 ? cmd.substring(0, 120) + "…" : cmd };
      }

      case "Grep":
        return { label: "Searching", detail: input.pattern || "" };

      case "Glob":
        return { label: "Finding files", detail: input.pattern || "" };

      case "Agent":
        return { label: "Running agent", detail: input.description || "" };

      case "WebSearch":
        return { label: "Searching web", detail: input.query || "" };

      case "WebFetch":
        return { label: "Fetching URL", detail: input.url || "" };

      case "Skill":
        return { label: "Running skill", detail: input.skill || "" };

      case "TodoWrite":
        return { label: "Updating tasks", detail: "" };

      default:
        return { label: `Running ${toolName}`, detail: "" };
    }
  }

  /**
   * Flush accumulated assistant text as an activity broadcast.
   * Called before switching to a different activity type.
   */
  private flushPendingText(agentId: string, agentProc: AgentProcess) {
    if (!agentProc.pendingText) return;

    const text = agentProc.pendingText.trim();
    if (text) {
      this.broadcastActivity(agentId, "thinking", "", text);
    }
    agentProc.pendingText = "";
  }

  /** Save session ID to Supabase so it survives bridge restarts */
  private async saveSessionId(agentId: string, sessionId: string) {
    await this.supabase
      .from("agents")
      .update({ session_id: sessionId })
      .eq("id", agentId);
  }

  /** Load session ID from Supabase */
  private async loadSessionId(agentId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from("agents")
      .select("session_id")
      .eq("id", agentId)
      .single();
    return data?.session_id || null;
  }

  async initAgent(agentId: string, agent: AgentRecord) {
    const workDir = join(this.agentsDir, agentId);

    // Create workspace if it doesn't exist
    if (!existsSync(workDir)) {
      mkdirSync(workDir, { recursive: true });
      mkdirSync(join(workDir, "notes"), { recursive: true });

      // Write initial MEMORY.md
      const memoryContent = `# ${agent.display_name}

## Role
${agent.description || agent.display_name}

## Key Knowledge
- No notes saved yet. Knowledge will accumulate through conversations.

## Active Context
- Status: First startup — no prior conversations.
- Workspace initialized at: ${new Date().toISOString().split("T")[0]}
`;
      writeFileSync(join(workDir, "MEMORY.md"), memoryContent);
      console.log(`  [${agent.display_name}] Workspace created: ${workDir}`);
    } else {
      console.log(`  [${agent.display_name}] Workspace exists: ${workDir}`);
    }

    // Initialize session
    this.sessions.set(agentId, {
      id: agentId,
      name: agent.name,
      displayName: agent.display_name,
      workDir,
    });

    // Update workspace_path in DB
    await this.supabase
      .from("agents")
      .update({ workspace_path: workDir })
      .eq("id", agentId);
  }

  /**
   * Send a message to an agent. Messages are queued and processed
   * sequentially — the next message is only sent after the current
   * turn completes (indicated by a "result" stream-json event).
   */
  async sendToAgent(agentId: string, userMessage: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    // Get agent record for system prompt
    const { data: agent } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .single();

    // Get MEMORY.md content
    let memoryContext = "";
    const memoryPath = join(session.workDir, "MEMORY.md");
    if (existsSync(memoryPath)) {
      memoryContext = readFileSync(memoryPath, "utf-8");
    }

    const systemPrompt = buildSystemPrompt(agent, memoryContext);
    const runtime = normalizeRuntime(agent?.runtime);
    const model = isKnownModelForRuntime(runtime, agent?.model)
      ? agent.model
      : defaultModelForRuntime(runtime);
    const reasoningEffort = isKnownReasoningEffortForRuntime(
      runtime,
      agent?.reasoning_effort
    )
      ? agent.reasoning_effort
      : defaultReasoningEffortForRuntime(runtime);

    // Ensure a persistent process is running
    let agentProc = this.processes.get(agentId);
    if (!agentProc || agentProc.proc.killed || agentProc.proc.exitCode !== null) {
      agentProc = await this.spawnProcess(
        agentId,
        session,
        systemPrompt,
        runtime,
        model,
        reasoningEffort
      );
      this.processes.set(agentId, agentProc);
    }

    if (
      (agentProc.driver.requiresSessionBeforeInput && !agentProc.sessionId) ||
      (agentProc.busy && !agentProc.driver.supportsSteer)
    ) {
      return this.queueMessage(agentProc, session, userMessage);
    }

    // Send immediately
    if (!this.deliverMessage(agentId, agentProc, session, userMessage)) {
      return this.queueMessage(agentProc, session, userMessage);
    }
  }

  private queueMessage(
    agentProc: AgentProcess,
    session: AgentSession,
    userMessage: string
  ): Promise<void> {
    console.log(
      `  [${session.displayName}] Agent busy or starting, queueing message (${userMessage.length} chars, queue size: ${agentProc.messageQueue.length + 1})...`
    );
    return new Promise<void>((resolve, reject) => {
      agentProc.messageQueue.push({ userMessage, resolve, reject });
    });
  }

  /** Write a message to the agent's stdin and mark it as busy */
  private deliverMessage(
    agentId: string,
    agentProc: AgentProcess,
    session: AgentSession,
    userMessage: string
  ): boolean {
    const stdinMsg = agentProc.driver.encodeUserMessage({
      userMessage,
      sessionId: agentProc.sessionId,
      turnId: agentProc.currentTurnId,
      busy: agentProc.busy,
    });
    if (!stdinMsg) return false;

    const displayName = session.displayName;
    console.log(
      `  [${displayName}] Forwarding message to ${agentProc.driver.displayName} (${userMessage.length} chars)...`
    );
    agentProc.busy = true;
    this.broadcastActivity(agentId, "working", "Working", "Message received");
    agentProc.proc.stdin?.write(stdinMsg + "\n");
    return true;
  }

  /** Process the next queued message, if any */
  private drainQueue(agentId: string, agentProc: AgentProcess) {
    const session = this.sessions.get(agentId);
    if (!session) return;

    const next = agentProc.messageQueue.shift();
    if (next) {
      console.log(
        `  [${session.displayName}] Draining queue (${agentProc.messageQueue.length} remaining)...`
      );
      if (this.deliverMessage(agentId, agentProc, session, next.userMessage)) {
        // Resolve the queued promise — message has been delivered
        next.resolve();
      } else {
        agentProc.messageQueue.unshift(next);
      }
    }
  }

  /**
   * Restart the agent process to pick up a fresh system prompt
   * (with updated MEMORY.md). Uses --resume to continue the session.
   */
  private async restartProcess(agentId: string) {
    const session = this.sessions.get(agentId);
    if (!session) return;

    const agentProc = this.processes.get(agentId);
    if (!agentProc) return;

    const displayName = session.displayName;
    const sessionId = agentProc.sessionId;

    console.log(
      `  [${displayName}] Restarting process for fresh system prompt (session: ${sessionId?.substring(0, 8) || "none"})...`
    );

    // Clean up old process
    if (agentProc.heartbeatTimer) {
      clearInterval(agentProc.heartbeatTimer);
    }

    // Save any queued messages before killing the process
    const pendingQueue = [...agentProc.messageQueue];
    agentProc.messageQueue = [];

    if (!agentProc.proc.killed) {
      agentProc.proc.kill();
    }

    // Build fresh system prompt with current MEMORY.md
    const { data: agent } = await this.supabase
      .from("agents")
      .select("*")
      .eq("id", agentId)
      .single();

    let memoryContext = "";
    const memoryPath = join(session.workDir, "MEMORY.md");
    if (existsSync(memoryPath)) {
      memoryContext = readFileSync(memoryPath, "utf-8");
    }

    const systemPrompt = buildSystemPrompt(agent, memoryContext);
    const runtime = normalizeRuntime(agent?.runtime);
    const model = isKnownModelForRuntime(runtime, agent?.model)
      ? agent.model
      : defaultModelForRuntime(runtime);
    const reasoningEffort = isKnownReasoningEffortForRuntime(
      runtime,
      agent?.reasoning_effort
    )
      ? agent.reasoning_effort
      : defaultReasoningEffortForRuntime(runtime);

    // Spawn new process — will resume the session via saved sessionId
    const newProc = await this.spawnProcess(
      agentId,
      session,
      systemPrompt,
      runtime,
      model,
      reasoningEffort
    );

    // Restore pending queue
    newProc.messageQueue = pendingQueue;

    this.processes.set(agentId, newProc);

    console.log(
      `  [${displayName}] Process restarted with fresh MEMORY.md.`
    );
  }

  /**
   * Set up CLI transport for the agent — writes a bash wrapper script
   * and env config into .zano/ directory in agent workspace.
   * Returns the .zano/ directory path (to prepend to PATH) and auth token file.
   */
  private prepareCliTransport(agentId: string, session: AgentSession): CliTransport {
    const zanoDir = join(session.workDir, ".zano");
    if (!existsSync(zanoDir)) {
      mkdirSync(zanoDir, { recursive: true });
    }

    const wrapperPath = join(zanoDir, "zano");
    let wrapperBody: string;

    // Try to resolve the compiled CLI from the published x-cli package first
    try {
      const req = createRequire(import.meta.url);
      const cliPath = req.resolve("@dp4ng/x-cli/dist/index.js");
      // Published mode: use node to run compiled JS directly
      wrapperBody = `#!/usr/bin/env bash\nexec node '${cliPath.replace(/'/g, "'\\''")}' "$@"\n`;
      console.log(`  [${session.displayName}] CLI resolved from npm package: ${cliPath}`);
    } catch {
      // Fall back to monorepo dev path (TypeScript source via tsx)
      const bridgeRoot = resolve(__dirname, "..");
      const cliPath = resolve(bridgeRoot, "..", "..", "packages", "cli", "src", "index.ts");
      const tsxPath = join(bridgeRoot, "node_modules", "tsx", "dist", "cli.mjs");
      wrapperBody = `#!/usr/bin/env bash\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${tsxPath.replace(/'/g, "'\\''")}' '${cliPath.replace(/'/g, "'\\''")}' "$@"\n`;
      console.log(`  [${session.displayName}] CLI resolved from monorepo dev path: ${cliPath}`);
    }

    writeFileSync(wrapperPath, wrapperBody, { mode: 0o755 });
    console.log(`  [${session.displayName}] CLI wrapper written: ${wrapperPath}`);

    const tokenFilePath = this.authToken ? join(zanoDir, "agent-token") : null;
    if (tokenFilePath) {
      writeFileSync(tokenFilePath, this.authToken, { mode: 0o600 });
    }

    return { zanoDir, tokenFilePath };
  }

  private buildAgentEnv(
    agentId: string,
    transport: CliTransport,
    runtime: RuntimeId,
    dbEnv: Record<string, string>
  ): NodeJS.ProcessEnv {
    const runtimeEnv = loadLocalRuntimeEnv({
      serverId: this.serverId,
      agentId,
      runtime,
    });

    return {
      ...process.env,
      ...runtimeEnv,
      ...dbEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      // CLI injection: agent identity + Supabase credentials
      ZANO_AGENT_ID: agentId,
      ZANO_SUPABASE_URL: this.supabaseUrl,
      ZANO_SUPABASE_KEY: this.supabaseKey,
      ...(this.authToken ? { ZANO_AUTH_TOKEN: this.authToken } : {}),
      ...(transport.tokenFilePath
        ? { ZANO_AUTH_TOKEN_FILE: transport.tokenFilePath }
        : {}),
      // Prepend .zano/ to PATH so `zano` command is available
      PATH: `${transport.zanoDir}:${process.env.PATH ?? ""}`,
    };
  }

  private async loadAgentEnvVars(agentId: string): Promise<Record<string, string>> {
    const { data, error } = await this.supabase
      .from("agent_runtime_settings")
      .select("env_vars")
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) {
      console.warn(
        `  [${agentId}] Failed to load agent env vars: ${error.message}`
      );
      return {};
    }

    const envVars = data?.env_vars;
    if (!envVars || typeof envVars !== "object" || Array.isArray(envVars)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(envVars).filter(
        ([, value]) => typeof value === "string"
      ) as Array<[string, string]>
    );
  }

  private async spawnProcess(
    agentId: string,
    session: AgentSession,
    systemPrompt: string,
    runtime: RuntimeId,
    model: string,
    reasoningEffort: string | null
  ): Promise<AgentProcess> {
    // Prepare CLI transport (.zano/ wrapper + env vars)
    const transport = this.prepareCliTransport(agentId, session);
    const driver = getRuntimeDriver(runtime);

    // Resume previous session: check in-memory first, then Supabase
    const prevProc = this.processes.get(agentId);
    const sessionId =
      prevProc?.sessionId || (await this.loadSessionId(agentId));
    const launch = driver.buildLaunch({
      agentId,
      displayName: session.displayName,
      workDir: session.workDir,
      systemPrompt,
      model,
      reasoningEffort,
      sessionId,
      zanoDir: transport.zanoDir,
      env: this.buildAgentEnv(
        agentId,
        transport,
        runtime,
        await this.loadAgentEnvVars(agentId)
      ),
    });

    if (launch.sessionId && launch.sessionId !== sessionId) {
      await this.saveSessionId(agentId, launch.sessionId);
    }

    console.log(
      `  [${session.displayName}] Spawning ${driver.displayName} (${sessionId ? `resume: ${sessionId.substring(0, 8)}` : "new session"}, model: ${model})...`
    );

    const proc = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const agentProc: AgentProcess = {
      proc,
      driver,
      runtime,
      sessionId: launch.sessionId || prevProc?.sessionId || null,
      currentTurnId: null,
      busy: false,
      stdoutBuffer: "",
      activity: "working",
      activityLabel: "Working",
      activityDetail: "Starting…",
      heartbeatTimer: null,
      messageQueue: [],
      pendingText: "",
    };

    // Broadcast initial activity
    this.broadcastActivity(agentId, "working", "Working", "Starting…");

    // Parse stdout line by line for stream-json events
    proc.stdout?.on("data", (chunk: Buffer) => {
      agentProc.stdoutBuffer += chunk.toString();
      const lines = agentProc.stdoutBuffer.split("\n");
      agentProc.stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleStreamEvent(agentId, agentProc, line.trim());
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      // Filter out noisy reconnection messages
      if (/Reconnecting\.\.\.|Falling back from WebSockets/i.test(text)) return;
      console.error(`  [${session.displayName}] stderr: ${text.substring(0, 200)}`);
    });

    proc.on("error", (err: Error) => {
      console.error(
        `  [${session.displayName}] Process error: ${err.message}`
      );
    });

    proc.on("close", (code: number | null) => {
      console.log(
        `  [${session.displayName}] Process exited with code ${code}`
      );
      // Reject any remaining queued messages
      for (const queued of agentProc.messageQueue) {
        queued.reject(new Error(`Agent process exited with code ${code}`));
      }
      agentProc.messageQueue = [];
    });

    for (const input of launch.initialInput) {
      proc.stdin?.write(input + "\n");
    }

    return agentProc;
  }

  private handleStreamEvent(
    agentId: string,
    agentProc: AgentProcess,
    line: string
  ) {
    const events = agentProc.driver.parseLine(line);
    for (const event of events) {
      this.handleRuntimeEvent(agentId, agentProc, event);
    }
  }

  private handleRuntimeEvent(
    agentId: string,
    agentProc: AgentProcess,
    event: ParsedRuntimeEvent
  ) {
    const session = this.sessions.get(agentId);
    const displayName = session?.displayName || agentId;

    switch (event.type) {
      case "session_init":
        agentProc.sessionId = event.sessionId;
        this.saveSessionId(agentId, event.sessionId);
        console.log(
          `  [${displayName}] Session initialized: ${event.sessionId.substring(0, 8)}...`
        );
        if (!agentProc.busy) {
          this.drainQueue(agentId, agentProc);
        }
        break;

      case "turn_started":
        agentProc.currentTurnId = event.turnId;
        agentProc.busy = true;
        break;

      case "thinking":
        this.flushPendingText(agentId, agentProc);
        this.broadcastActivity(
          agentId,
          "thinking",
          "Thinking",
          event.text || ""
        );
        break;

      case "text":
        agentProc.pendingText += event.text || "";
        break;

      case "tool_call": {
        this.flushPendingText(agentId, agentProc);
        const { label, detail } =
          event.label || event.detail
            ? { label: event.label || `Running ${event.name}`, detail: event.detail || "" }
            : this.describeToolUse({
                name: event.name,
                input: event.input || {},
              });
        this.broadcastActivity(agentId, "working", label, detail);
        break;
      }

      case "compaction_started":
        this.flushPendingText(agentId, agentProc);
        this.broadcastActivity(agentId, "working", "Optimizing context", "");
        if (agentProc.runtime === "claude") {
          // Restart Claude after compaction to pick up fresh MEMORY.md in the system prompt.
          console.log(
            `  [${displayName}] Context compaction detected — scheduling process restart for fresh MEMORY.md...`
          );
          this.restartProcess(agentId).catch((err) => {
            console.error(
              `  [${displayName}] Failed to restart after compaction: ${err.message}`
            );
          });
        }
        break;

      case "compaction_finished":
        this.broadcastActivity(agentId, "working", "Context optimized", "");
        break;

      case "turn_end":
        // Flush any final text
        this.flushPendingText(agentId, agentProc);
        // Turn is complete — save session ID
        if (event.sessionId) {
          agentProc.sessionId = event.sessionId;
          this.saveSessionId(agentId, event.sessionId);
        }
        agentProc.busy = false;
        agentProc.currentTurnId = null;
        this.broadcastActivity(agentId, "idle", "Idle", "");
        console.log(`  [${displayName}] Turn complete.`);

        // Process next queued message if any
        this.drainQueue(agentId, agentProc);
        break;

      case "error":
        this.flushPendingText(agentId, agentProc);
        this.broadcastActivity(agentId, "error", "Runtime error", event.message);
        console.error(`  [${displayName}] Runtime error: ${event.message}`);
        if (!agentProc.sessionId) {
          for (const queued of agentProc.messageQueue) {
            queued.reject(new Error(event.message));
          }
          agentProc.messageQueue = [];
        }
        break;
    }
  }

  /** Get the workspace directory for an agent */
  getWorkspaceDir(agentId: string): string | null {
    return this.sessions.get(agentId)?.workDir ?? null;
  }

  stopAgent(agentId: string) {
    const agentProc = this.processes.get(agentId);
    if (agentProc) {
      if (agentProc.heartbeatTimer) {
        clearInterval(agentProc.heartbeatTimer);
      }
      for (const queued of agentProc.messageQueue) {
        queued.reject(new Error("Agent stopped"));
      }
      agentProc.messageQueue = [];
      if (!agentProc.proc.killed) {
        agentProc.proc.kill();
      }
      this.processes.delete(agentId);
    }

    this.sessions.delete(agentId);
  }

  stopAll() {
    // Kill all running processes and clean up heartbeats
    for (const [agentId, agentProc] of this.processes) {
      if (agentProc.heartbeatTimer) {
        clearInterval(agentProc.heartbeatTimer);
      }
      // Reject any queued messages
      for (const queued of agentProc.messageQueue) {
        queued.reject(new Error("Agent manager stopped"));
      }
      agentProc.messageQueue = [];
      if (!agentProc.proc.killed) {
        console.log(`  Stopping agent process: ${agentId}`);
        agentProc.proc.kill();
      }
    }
    this.processes.clear();
    this.sessions.clear();
    this.supabase.removeChannel(this.activityChannel);
  }
}
