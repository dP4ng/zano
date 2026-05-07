import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyServerDataChanged,
  subscribeServerDataChanged,
} from "./server-data-events";

Object.defineProperty(globalThis, "window", {
  value: new EventTarget(),
  configurable: true,
});

test("notifies listeners for the matching server only", () => {
  const calls: string[] = [];
  const unsubscribe = subscribeServerDataChanged("server-a", (detail) => {
    calls.push(detail.resource ?? "unknown");
  });

  notifyServerDataChanged({ serverId: "server-b", resource: "channels" });
  assert.deepEqual(calls, []);

  notifyServerDataChanged({ serverId: "server-a", resource: "channels" });
  assert.deepEqual(calls, ["channels"]);

  unsubscribe();
  notifyServerDataChanged({ serverId: "server-a", resource: "channels" });
  assert.deepEqual(calls, ["channels"]);
});
