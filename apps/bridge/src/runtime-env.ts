import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeId } from "./runtimes/index.js";

type ConfigMap = Record<string, unknown>;

export interface RuntimeEnvContext {
  serverId: string;
  agentId: string;
  runtime: RuntimeId;
  baseEnv?: Record<string, string>;
}

export interface LoadRuntimeEnvContext extends RuntimeEnvContext {
  configFile?: string;
  envFile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    if (!isEnvKey(key)) continue;

    env[key] = parseScalar(line.slice(equalsIndex + 1).trim());
  }

  return env;
}

export function parseRuntimeEnvConfig(text: string): ConfigMap {
  const root: ConfigMap = {};
  const stack: Array<{ indent: number; value: ConfigMap }> = [
    { indent: -1, value: root },
  ];

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const trimmed = rawLine.trim();
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) continue;

    const key = unquote(trimmed.slice(0, separatorIndex).trim());
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    while (stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (!rawValue) {
      const child: ConfigMap = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

export function resolveRuntimeEnv(
  config: ConfigMap,
  ctx: RuntimeEnvContext
): Record<string, string> {
  const env: Record<string, string> = { ...(ctx.baseEnv || {}) };
  const defaults = asMap(config.defaults);
  const servers = asMap(config.servers);
  const server = asMap(servers[ctx.serverId]);
  const serverDefaults = asMap(server.defaults);
  const agents = asMap(config.agents);
  const topLevelAgent = asMap(agents[ctx.agentId]);
  const serverAgents = asMap(server.agents);
  const serverAgent = asMap(serverAgents[ctx.agentId]);

  mergeEnv(env, config.env);
  mergeEnv(env, runtimeEnv(defaults, ctx.runtime));
  mergeEnv(env, server.env);
  mergeEnv(env, runtimeEnv(serverDefaults, ctx.runtime));
  mergeEnv(env, topLevelAgent.env ?? topLevelAgent);
  mergeEnv(env, serverAgent.env ?? serverAgent);

  return env;
}

export function loadLocalRuntimeEnv(
  ctx: LoadRuntimeEnvContext
): Record<string, string> {
  const env = ctx.env || process.env;
  const home = ctx.homeDir || homedir();
  const envFile =
    ctx.envFile || env.ZANO_AGENT_ENV_FILE || join(home, ".zano", ".env");
  const configFile =
    ctx.configFile || env.ZANO_CONFIG_FILE || join(home, ".zano", "config.yaml");

  let baseEnv: Record<string, string> = {};
  if (existsSync(envFile)) {
    baseEnv = parseEnvFile(readFileSync(envFile, "utf-8"));
  }

  if (!existsSync(configFile)) {
    return resolveRuntimeEnv({}, { ...ctx, baseEnv });
  }

  const config = parseRuntimeEnvConfig(readFileSync(configFile, "utf-8"));
  return resolveRuntimeEnv(config, { ...ctx, baseEnv });
}

function runtimeEnv(config: ConfigMap, runtime: RuntimeId): unknown {
  const runtimeConfig = asMap(config[runtime]);
  return runtimeConfig.env ?? runtimeConfig;
}

function mergeEnv(target: Record<string, string>, value: unknown) {
  for (const [key, rawValue] of Object.entries(asMap(value))) {
    if (isEnvKey(key) && typeof rawValue === "string") {
      target[key] = rawValue;
    }
  }
}

function asMap(value: unknown): ConfigMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ConfigMap)
    : {};
}

function isEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function parseScalar(value: string): string {
  const unquoted = unquote(value);
  if (unquoted !== value) return unquoted;
  return value;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
