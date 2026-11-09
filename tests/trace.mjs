import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const js = await readFile(new URL("../mods/magpie-routing/trace.js", import.meta.url), "utf8");
const { readTrace, TRACE_URL } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const trace = { object: "trace", seq: 3, routes: [] }, calls = [];
const io = {
  async fetch(url) { calls.push({ url, kind: "fetch" }); return { ok: true, json: async () => trace }; },
  async exec(command, args, options) { calls.push({ command, args, options, kind: "exec" }); return { code: 0, stdout: JSON.stringify(trace), stderr: "" }; },
};
assert.deepEqual(await readTrace(null, 0, false, io), trace);
assert.equal(calls[0].url, TRACE_URL + "?after=0");
assert.deepEqual(await readTrace("example-remote", 3, true, io), trace);
assert.deepEqual(calls[1], {
  command: "curl", kind: "exec", options: { on: "example-remote", timeout: 30000 },
  args: ["--silent", "--show-error", "--fail", "--noproxy", "*", "--connect-timeout", "3", "--max-time", "28", TRACE_URL + "?after=3&wait=1"],
});
await assert.rejects(readTrace("offline", 0, false, { exec: async () => { throw new Error("machine unavailable"); } }), /machine unavailable/);
await assert.rejects(readTrace("no-magpie", 0, false, { exec: async () => ({ code: 7, stderr: "Connection refused\n" }) }), /Connection refused/);
await assert.rejects(readTrace(null, 0, false, { fetch: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
await assert.rejects(readTrace("bad-json", 0, false, { exec: async () => ({ code: 0, stdout: "not json" }) }), SyntaxError);
console.log("Trace transport self-check passed (local fetch, remote loopback exec, proxy bypass, long-poll deadlines, offline/HTTP/JSON errors).");
