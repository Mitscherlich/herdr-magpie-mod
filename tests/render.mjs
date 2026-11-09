import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import vm from "node:vm";

const source = path => readFile(new URL(path, import.meta.url), "utf8");
const declarations = await source("../mods/magpie-routing/gpui-kit.d.ts");
const methods = new Set([...declarations.matchAll(/^\s+(\w+)(?:<Self[^\n]+>|)\(/gm)].map(m => m[1]));
// Keep the mock to one builder: no platform rendering is simulated.
function element(kind) {
  const node = { kind, nodes: [], calls: [] };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    assert(methods.has(key), `Undocumented GPUI method: ${String(key)}`);
    return (...args) => {
      target.calls.push([key, args]);
      if (key === "when" && args[0]) args[1](proxy);
      if (key === "child" || key === "trigger" || key === "content") { assert(args[0] !== undefined, `${key}(undefined)`); target.nodes.push(args[0]); }
      if (key === "children") target.nodes.push(...args[0]);
      for (const arg of args) if (typeof arg === "number") assert(Number.isFinite(arg), `${key} has non-finite length`);
      return proxy;
    };
  } });
  return proxy;
}
const tasks = [], cx = { spawn: fn => tasks.push(fn), timer: { every() {} }, focus_handle: () => ({ focus() {} }), phase: () => "event", notify() {} };
const renderCx = { ...cx, phase: () => "render", notify() { assert.fail("render must not request another render"); } };
const path = { move_to() { return this; }, line_to() { return this; }, cubic_bezier_to() { return this; }, dash_array() { return this; }, build() { return {}; } };
const theme = new Proxy({}, { get: () => "#888888" });
const sandbox = vm.createContext({
  View: class {}, div: () => element("div"), svg: () => element("svg"), image: () => element("image"),
  v_flex: () => element("column"), h_flex: () => element("row"), PathBuilder: { stroke: () => path },
  Popover: { new: () => element("popover") },
  Scrollbar: { horizontal: () => element("scrollbar"), vertical: () => element("scrollbar") },
  window: { paint_path: () => element("path") }, theme: () => theme,
  hostWindow: () => ({ active: sandbox.active }), appHome: () => tmpdir(), exec: () => new Promise(() => {}),
  machines: () => [{ name: null, layout: "ready" }, { name: "example-remote", layout: "ready" }, { name: "offline", layout: "unavailable" }],
  spaces: () => sandbox.sessions,
  layout: () => ({ children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "routing" }] }), run() {},
  nextCommand: () => new Promise(() => {}), fetch: () => new Promise(() => {}), Date, console, cx, Intl: undefined,
});
sandbox.active = true;
sandbox.sessions = [{ id: "local-space", active: true, machine: null, tabs: [{ id: "local-tab", active: true }] }];
const routes = (await source("../mods/magpie-routing/routes.js")).replaceAll("export ", "");
const trace = (await source("../mods/magpie-routing/trace.js")).replaceAll("export ", "");
const main = (await source("../mods/magpie-routing/main.js")).replace(/^import .*;\n/gm, "").replace("export default class Routing", "class Routing");
vm.runInContext(routes + "\n" + trace + "\n" + main + "\n Object.assign(globalThis, { whole, source, Routing }); globalThis.view = new Routing(); view.init({}, cx);", sandbox);
function inspect(root) {
  const ids = new Set();
  for (const node of [root]) walk(node);
  function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const [key, args] of node.calls) if (key === "id") { assert(!ids.has(args[0]), `Duplicate ID: ${args[0]}`); ids.add(args[0]); }
    for (const child of node.nodes) walk(child);
  }
  return ids;
}
assert(inspect(sandbox.view.render(renderCx)).has("routing-root"));
const now = Date.now();
const base = { id: 1, agent: "codex", model: "p/m", provider: "p", time: new Date(now).toISOString(), done: false, order: [{ id: "p", provider: "p", name: "Provider", model: "m" }], tries: [{ id: "p", model: "m", done: false }] };
for (const width of [280, 368, 560, 900]) {
  for (const fields of [{}, { contentAt: now - 16000 }, { done: true, status: 200, tries: [{ id: "p", model: "m", done: true, status: 200, ms: 1200 }] }, { done: true, canceled: true }, { done: true, status: 429, tries: [{ id: "p", model: "m", done: true, status: 429, fail: "rate limited" }] }]) {
    sandbox.view.width = width;
    sandbox.view.routes.set(1, sandbox.whole({ ...base, ...fields }));
    assert(inspect(sandbox.view.render(renderCx)).has("request-1"));
  }
}
sandbox.view.routes.set(2, sandbox.whole({ ...base, id: 2, agent: "claude", callerKey: "second" }));
sandbox.view.routes.set(3, sandbox.whole({ ...base, id: 3, callerKey: "third" }));
sandbox.view.render(renderCx);
sandbox.view.connected = true;
const f = { id: 2, from: sandbox.source(sandbox.view.routes.get(2)), tr: base.tries[0], at: "row", visible: true, held: true };
sandbox.view.flights.set(2, f);
assert(inspect(sandbox.view.render(renderCx)).has("packet-2"));
f.held = false; f.back = true; f.failed = true;
f.clip = { path: "data/magpie-routing/test.webp", x: 1, y: 2, width: 100, height: 40, id: 42 };
assert(inspect(sandbox.view.render(renderCx)).has("flight-2-42"), "native flight gets a trip-specific image ID");
assert(!inspect(sandbox.view.render(renderCx)).has("routing-magpie"), "the video has no stationary hub bird");
sandbox.view.picked = 1;
assert(!inspect(sandbox.view.render(renderCx)).has("packet-2"));
sandbox.view.clearFlights();
sandbox.view.picked = null;
sandbox.view.connected = false;
sandbox.view.startFlights(cx);
assert.equal(sandbox.view.flights.size, 0, "offline data never starts a flight");
sandbox.view.connected = true;
sandbox.view.routes.clear();
sandbox.view.routes.set(10, sandbox.whole({ ...base, id: 10, tries: [] }));
const before = tasks.length;
const travel = sandbox.view.travel;
sandbox.view.travel = async () => {};
sandbox.view.startFlights(cx);
assert.equal(tasks.length, before + 1);
const pending = tasks.at(-1)(cx);
await new Promise(resolve => setImmediate(resolve));
assert.equal(sandbox.view.waiters.size, 1);
sandbox.view.clearFlights();
await pending;
assert.equal(sandbox.view.waiters.size, 0, "stopped no-seat flight must not wait again");
sandbox.view.travel = travel;
sandbox.view.routes.set(11, sandbox.whole({ ...base, id: 11 }));
const model = sandbox.view.model();
assert(model.g.rows.has("p\u0001m"), "new seat does not depend on the previous render");
// A no-seat route completes while the outbound flight plays.
sandbox.view.routes.clear();
sandbox.view.routes.set(20, sandbox.whole({ ...base, id: 20, tries: [] }));
sandbox.view.travel = async (_f, kind) => {
  if (kind === "hub") sandbox.view.routes.set(20, sandbox.whole({ ...base, id: 20, done: true, tries: [{ ...base.tries[0], done: true, status: 200 }] }));
};
sandbox.view.startFlights(cx);
await tasks.at(-1)(cx);
assert.equal(sandbox.view.waiters.size, 0, "newly completed request cannot get stuck waiting on the old pre-flight snapshot");
assert.equal(sandbox.view.flights.size, 0);
sandbox.view.travel = travel;
const clips = [], sleeps = [];
const moving = { id: 20, from: sandbox.source(sandbox.view.routes.get(20)), tr: base.tries[0], back: false };
sandbox.view.clip = async spec => { clips.push(spec); return { path: "test.webp", duration: spec.duration + 550 }; };
await sandbox.view.travel(moving, "out", 1400, {
  notify() {},
  async sleep(ms) { assert(ms > 0); sleeps.push(ms); },
});
assert.equal(clips.length, 1, "GPUI owns every flight frame, no JS path animation ticks");
assert.equal(clips[0].paths.length, 1);
assert.equal(moving.visible, false);
assert.equal(sleeps[0], 1900, "remove in the held tail before native image playback loops to the departure");
sandbox.active = false;
await sandbox.view.travel(moving, "out", 1400, { notify() {}, sleep() {} });
assert.equal(clips.length, 1, "background windows do not consume a one-shot clip while native playback is paused");
const reads = [];
sandbox.readTrace = (machine, seq, wait) => new Promise((resolve, reject) => reads.push({ machine, seq, wait, resolve, reject }));
const switched = new sandbox.Routing();
switched.init({}, cx);
const localPoll = tasks.at(-1)(cx);
assert.equal(reads[0].machine, null);
switched.selectMachine("example-remote", cx);
const remotePoll = tasks.at(-1)(cx);
assert.equal(reads[1].machine, "example-remote");
reads[0].resolve({ object: "trace", seq: 1, pid: 1, routes: [base], now: new Date().toISOString() });
await localPoll;
assert.equal(switched.routes.size, 0, "old machine's completed long poll cannot populate the new source");
reads[1].resolve({ object: "trace", seq: 8, pid: 2, routes: [{ ...base, id: 80 }], now: new Date().toISOString() });
await new Promise(resolve => setImmediate(resolve));
assert.equal(switched.pid, 2);
assert(switched.routes.has(80));
assert.equal(reads[2].seq, 8);
assert.equal(reads[2].wait, true);
switched.selectMachine(null, cx);
reads[2].reject(new Error("old remote connection failed"));
await remotePoll;
assert.equal(switched.error, null, "stale remote failure cannot mark the local source offline");
assert.equal(switched.routes.size, 0);
assert.equal(switched.seq, 0);
assert.equal(switched.pid, null);
assert.equal(switched.connected, false);
assert.equal(switched.machineName(), "This computer");
assert(!switched.available("offline"));
switched.machineMenu = true;
assert(inspect(switched.render(renderCx)).has("routing-machine-example-remote"));
const generation = switched.connection;
switched.close();
assert.equal(switched.connection, generation + 1, "closing invalidates any outstanding poll");

sandbox.sessions = [{ id: "remote-space", active: true, machine: "example-remote", tabs: [{ id: "remote-tab", active: true }] }];
const following = new sandbox.Routing();
following.init({}, cx);
assert.equal(following.machine, "example-remote", "the initial session selects its remote machine before polling");
const initialRead = reads.length, initialPoll = tasks.at(-1)(cx);
assert.equal(reads[initialRead].machine, "example-remote");
following.selectMachine(null, cx);
following.machineMenu = true;
const manualGeneration = following.connection;
following.render(renderCx);
assert.equal(following.machine, null, "an ordinary render must preserve the manual override");
assert.equal(following.machineMenu, true);
assert.equal(following.connection, manualGeneration);
sandbox.sessions[0].tabs = [{ id: "another-tab", active: true }];
following.render(renderCx);
assert.equal(following.machine, "example-remote", "changing tabs follows the session even within the same space");
assert.equal(following.machineMenu, false);
reads[initialRead].resolve({ object: "trace", seq: 9, pid: 3, routes: [base], now: new Date().toISOString() });
await initialPoll;
assert.equal(following.routes.size, 0, "a poll from before automatic and manual switches stays invalid");
following.routes.set(1, sandbox.whole(base));
const sameMachineGeneration = following.connection;
sandbox.sessions[0].id = "another-remote-space";
following.render(renderCx);
assert.equal(following.connection, sameMachineGeneration, "another session on the same target keeps the connection and requests");
assert(following.routes.has(1));
following.picked = 1; following.totals = { requests: 8 }; following.machineMenu = true;
sandbox.sessions = [{ id: "local-space", active: true, machine: null, tabs: [{ id: "local-tab", active: true }] }];
const tree = following.render(renderCx);
assert.equal(following.machine, null, "switching back to a local session follows This computer");
assert.equal(following.routes.size, 0);
assert.equal(following.picked, null);
assert.equal(Object.keys(following.totals).length, 0);
assert.equal(following.machineMenu, false);
const header = tree.nodes.find(node => node.calls?.some(([key, args]) => key === "id" && args[0] === "routing-header"));
assert(header && inspect(header).has("routing-machine-picker"), "the machine picker belongs to the Magpie title bar");
const picker = header.nodes.find(node => node.kind === "popover");
assert(picker, "native Popover handles anchoring and dismissal without a separate row");
const openChange = picker.calls.find(([key]) => key === "on_open_change")[1][0];
openChange(true, cx);
assert.equal(following.machineMenu, true, "native trigger opens the controlled menu");
openChange(false, cx);
assert.equal(following.machineMenu, false, "native outside press or Escape closes the menu");
const trigger = picker.calls.find(([key]) => key === "trigger")[1][0];
trigger.calls.find(([key]) => key === "on_key_down")[1][0]({ key: "enter" }, cx);
assert.equal(following.machineMenu, true, "the title-bar trigger also opens from the keyboard");
const menu = picker.calls.find(([key]) => key === "content")[1][0];
menu.nodes.find(node => node.calls.some(([key, args]) => key === "id" && args[0] === "routing-machine-example-remote"))
  .calls.find(([key]) => key === "on_key_down")[1][0]({ key: "space" }, cx);
assert.equal(following.machine, "example-remote", "a keyboard selection uses the shared machine switch");
assert.equal(following.machineMenu, false);
sandbox.sessions = [];
following.selectMachine("offline", cx);
const unavailableGeneration = following.connection;
following.render(renderCx);
assert.equal(following.machine, "offline", "a temporarily missing active session must not force a local fallback");
assert.equal(following.connection, unavailableGeneration);
following.close();

sandbox.active = true;
const animationArgs = [];
sandbox.exec = async (_program, args) => {
  animationArgs.push(args);
  return { code: 0, stdout: JSON.stringify({ path: "data/magpie-routing/test.webp", duration: 700 }) };
};
const animated = new sandbox.Routing();
animated.init({}, cx);
const callerKey = "example-caller", accountId = "provider#example-account";
const privateRoute = sandbox.whole({ ...base, callerKey, order: [{ ...base.order[0], id: accountId, who: "account@example.com" }], tries: [{ ...base.tries[0], id: accountId }] });
animated.routes.set(1, privateRoute);
animated.routes.set(2, { ...privateRoute, id: 2 });
animated.connected = true;
animated.updateFlow(cx);
await tasks.at(-1)(cx);
assert.equal(animationArgs.length, 1);
const animationSpec = JSON.parse(animationArgs[0][1]);
assert.equal(animationSpec.wires.length, 1, "requests on the same route still share one animated wire");
assert.deepEqual(Object.keys(animationSpec.wires[0]).sort(), ["color", "path"], "the renderer receives only drawing data");
for (const identity of [callerKey, accountId, "account@example.com"]) {
  assert(!animationArgs[0].some(arg => arg.includes(identity)), "caller and account identifiers must stay out of subprocess arguments");
}
assert(animated.flow, "removing identity fields must not prevent a flow clip from loading");
animated.close();
console.log("Routing render self-check passed (documented API, request states, narrow/wide, flights, session machine following, manual override, stale polls, title-bar picker, animation argument privacy).");
