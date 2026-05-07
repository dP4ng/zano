import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEnvFile,
  parseRuntimeEnvConfig,
  resolveRuntimeEnv,
} from "../src/runtime-env.js";

test("parses env files as global runtime env defaults", () => {
  assert.deepEqual(parseEnvFile("OPENAI_API_KEY=from-env\n# ignored\nEMPTY=\n"), {
    OPENAI_API_KEY: "from-env",
    EMPTY: "",
  });
});

test("resolves local runtime env with runtime, server, and agent precedence", () => {
  const config = parseRuntimeEnvConfig(`
env:
  SHARED: global
  OPENAI_API_KEY: global-openai
defaults:
  codex:
    env:
      OPENAI_API_KEY: default-openai
servers:
  server-1:
    env:
      SERVER_ONLY: server-value
    defaults:
      codex:
        env:
          OPENAI_API_KEY: server-openai
    agents:
      agent-1:
        env:
          OPENAI_API_KEY: agent-openai
          AGENT_ONLY: agent-value
`);

  assert.deepEqual(
    resolveRuntimeEnv(config, {
      serverId: "server-1",
      agentId: "agent-1",
      runtime: "codex",
      baseEnv: { FROM_ENV_FILE: "env-file-value", OPENAI_API_KEY: "env-file-openai" },
    }),
    {
      FROM_ENV_FILE: "env-file-value",
      SHARED: "global",
      OPENAI_API_KEY: "agent-openai",
      SERVER_ONLY: "server-value",
      AGENT_ONLY: "agent-value",
    }
  );
});
