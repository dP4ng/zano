import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultModelForRuntime,
  defaultReasoningEffortForRuntime,
  getRuntimeDriver,
  isKnownReasoningEffortForRuntime,
  normalizeRuntime,
} from "../src/runtimes/index.js";

const baseEnv = { PATH: "/usr/bin" };

test("normalizes unsupported runtimes to claude defaults", () => {
  assert.equal(normalizeRuntime("codex"), "codex");
  assert.equal(normalizeRuntime("not-a-runtime"), "claude");
  assert.equal(defaultModelForRuntime("claude"), "opus");
  assert.equal(defaultModelForRuntime("codex"), "gpt-5.5");
  assert.equal(defaultModelForRuntime("kimi"), "default");
});

test("claude driver supports effort levels and passes them to Claude Code", () => {
  assert.equal(defaultReasoningEffortForRuntime("claude"), "high");
  assert.equal(isKnownReasoningEffortForRuntime("claude", "max"), true);
  assert.equal(isKnownReasoningEffortForRuntime("codex", "max"), false);

  const driver = getRuntimeDriver("claude");
  const launch = driver.buildLaunch({
    agentId: "agent-1",
    displayName: "Claude Agent",
    workDir: "/workspace/agent-1",
    systemPrompt: "system instructions",
    model: "opus",
    reasoningEffort: "max",
    sessionId: null,
    zanoDir: "/workspace/agent-1/.zano",
    env: baseEnv,
  });

  assert.equal(launch.command, "claude");
  assert.deepEqual(
    launch.args.slice(launch.args.indexOf("--effort"), launch.args.indexOf("--effort") + 2),
    ["--effort", "max"]
  );
});

test("codex driver starts app-server and seeds a thread with developer instructions", () => {
  const driver = getRuntimeDriver("codex");
  const launch = driver.buildLaunch({
    agentId: "agent-1",
    displayName: "Codex Agent",
    workDir: "/workspace/agent-1",
    systemPrompt: "system instructions",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    sessionId: null,
    zanoDir: "/workspace/agent-1/.zano",
    env: baseEnv,
  });

  assert.equal(launch.command, "codex");
  assert.deepEqual(launch.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.match(launch.initialInput.join("\n"), /"method":"initialize"/);
  assert.match(launch.initialInput.join("\n"), /"method":"thread\/start"/);
  assert.match(launch.initialInput.join("\n"), /"developerInstructions":"system instructions"/);
  assert.match(launch.initialInput.join("\n"), /"model_reasoning_effort":"xhigh"/);
});

test("kimi driver starts wire mode with generated agent and mcp config files", () => {
  const workDir = mkdtempSync(join(tmpdir(), "zano-kimi-"));
  const driver = getRuntimeDriver("kimi");
  const launch = driver.buildLaunch({
    agentId: "agent-1",
    displayName: "Kimi Agent",
    workDir,
    systemPrompt: "system instructions",
    model: "default",
    reasoningEffort: null,
    sessionId: null,
    zanoDir: join(workDir, ".zano"),
    env: baseEnv,
  });

  assert.equal(launch.command, "kimi");
  assert.ok(launch.args.includes("--wire"));
  assert.ok(launch.args.includes("--agent-file"));
  assert.ok(launch.args.includes("--mcp-config-file"));
  const initializeRequest = JSON.parse(launch.initialInput[0]);
  assert.equal(initializeRequest.method, "initialize");
  assert.equal(typeof initializeRequest.id, "string");
  assert.equal(initializeRequest.params.protocol_version, "1.9");
});

test("kimi driver sends prompt and steer requests with string ids and user_input params", () => {
  const driver = getRuntimeDriver("kimi");

  const promptRequest = JSON.parse(
    driver.encodeUserMessage({
      userMessage: "hello",
      sessionId: "session-1",
      turnId: null,
      busy: false,
    })!
  );
  assert.equal(promptRequest.method, "prompt");
  assert.equal(typeof promptRequest.id, "string");
  assert.deepEqual(promptRequest.params, { user_input: "hello" });

  const steerRequest = JSON.parse(
    driver.encodeUserMessage({
      userMessage: "wait",
      sessionId: "session-1",
      turnId: null,
      busy: true,
    })!
  );
  assert.equal(steerRequest.method, "steer");
  assert.equal(typeof steerRequest.id, "string");
  assert.deepEqual(steerRequest.params, { user_input: "wait" });
});

test("kimi driver parses payload-wrapped content events", () => {
  const driver = getRuntimeDriver("kimi");

  assert.deepEqual(
    driver.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "ContentPart",
        payload: { type: "text", text: "hello" },
      },
    })),
    [{ type: "text", text: "hello" }]
  );

  assert.deepEqual(
    driver.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "ContentPart",
        payload: { type: "think", think: "checking" },
      },
    })),
    [{ type: "thinking", text: "checking" }]
  );
});
