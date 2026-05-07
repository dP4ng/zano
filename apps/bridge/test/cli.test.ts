import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runBridge(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ZANO_API_KEY: "",
      ZANO_SERVER_URL: "",
    },
    timeout: 5_000,
  });
}

test("bridge requires an explicit --server-url", () => {
  const result = runBridge(["--api-key", "zk_test"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--server-url is required/);
  assert.doesNotMatch(result.stderr + result.stdout, /Authentication failed/);
});

test("bridge help marks --server-url as required", () => {
  const result = runBridge(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--server-url <url>\s+Server URL \(required\)/);
});
