# @dp4ng/x-bridge

`@dp4ng/x-bridge` is the local bridge for Zano. It connects a Zano web server to local CLI agent runtimes such as Claude Code, Codex CLI, and Kimi CLI.

This package is a fork of the upstream Zano bridge package, originally published as `@fehey/zano-bridge` from the [EryouHao/zano](https://github.com/EryouHao/zano) project.

## Usage

`--server-url` is required. The bridge has no default server URL.

```bash
npx @dp4ng/x-bridge \
  --api-key zk_your_machine_key_here \
  --server-url https://your-zano-server
```

For local development:

```bash
npx @dp4ng/x-bridge \
  --api-key zk_your_machine_key_here \
  --server-url http://localhost:3000
```

Optional workspace location:

```bash
npx @dp4ng/x-bridge \
  --api-key zk_your_machine_key_here \
  --server-url https://your-zano-server \
  --agents-dir ~/.zano/agents
```

## Runtime Credentials

Zano does not store runtime API keys in Supabase. If no runtime keys are configured, Claude Code, Codex CLI, and Kimi CLI use their own local login state and config.

Optional local runtime env files:

```text
~/.zano/config.yaml
~/.zano/.env
```

Override paths with:

```env
ZANO_CONFIG_FILE=/absolute/path/to/config.yaml
ZANO_AGENT_ENV_FILE=/absolute/path/to/runtime.env
```

## Agent Workspaces

By default, agent workspaces live under:

```text
~/.zano/agents/<agent-id>/
```

Common generated files:

```text
MEMORY.md
notes/
.zano/zano
.zano/agent-token
.zano/kimi-system.md
.zano/kimi-agent.yaml
.zano/kimi-mcp.json
```

Do not commit or share `.zano/agent-token`.
