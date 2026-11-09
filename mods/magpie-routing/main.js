import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, Popover } from "gpui-base";
import { layout, run, theme, nextCommand, appHome, exec, machines, spaces, window as hostWindow } from "herdr";
import { source, seat, ok, mergeTrace, staged, seats, stateOf, geometry, curve, way, destination, speed } from "./routes.js";
import { readTrace } from "./trace.js";

const ASSETS = "mods/magpie-routing/";
const NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", crush: "Crush", gemini: "Gemini", cursor: "Cursor", pi: "Pi" };
function find(n, id) { if (n?.id === id) return n; for (const c of n?.children || []) { const found = find(c, id); if (found) return found; } return null; }
function shown() { const root = layout(); return !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "routing"; }
const number = n => (n || 0).toLocaleString();
const compact = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const time = text => { const d = new Date(text); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":"); };
const label = (text, size, c) => div().text_size(size).text_color(c).child(text);
const stop = (_e, cx) => cx.stop_propagation();

export default class Routing extends View {
  init(props, cx) {
    this.routes = new Map(); this.seq = 0; this.flights = new Map(); this.waiters = new Map();
    this.python = props?.python || "python3"; this.trip = 0; this.width = 420; this.totals = {}; this.error = null; this.masked = true; this.connected = false; this.handle = cx.focus_handle();
    this.played = new Set(); this.fresh = new Set();
    const space = spaces().find(s => s.active);
    this.space = space?.id; this.tab = space?.tabs.find(t => t.active)?.id;
    this.machine = space?.machine ?? null; this.connection = 0; this.machineMenu = false;
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        if (command === "replay") this.replay(cx);
        if (command === "live") { this.clearFlights(); this.picked = null; this.startFlights(cx); this.updateFlow(cx); cx.notify(); }
      }
    });
    this.startTrace(cx);
    // Data deadlines only: no JavaScript animation ticks.
    cx.timer.every(1000, cx => {
      if (!shown()) { this.clearFlights(); return; }
      if (!hostWindow().active) this.clearFlights();
      else this.startFlights(cx);
      this.updateFlow(cx);
      if ([...this.routes.values()].some(r => !r.done || this.now() - Date.parse(r.time) - (r.ms || 0) < 13000)) cx.notify();
    });
  }

  machineName() { return this.machine ?? "This computer"; }
  available(machine = this.machine) { return machine === null || machines().some(m => m.name === machine && m.layout === "ready"); }
  selectMachine(machine, cx) {
    this.machineMenu = false;
    if (this.machine === machine) { if (cx.phase() !== "render") cx.notify(); return; }
    this.machine = machine;
    this.resetTrace(cx);
  }
  resetTrace(cx) {
    this.clearFlights(); this.routes.clear(); this.seq = 0; this.pid = null; this.picked = null;
    this.connected = false; this.error = null; this.animationError = null; this.skew = 0; this.totals = {}; this.serves = null;
    this.startTrace(cx);
    if (cx.phase() !== "render") cx.notify();
  }
  startTrace(cx) {
    const generation = ++this.connection, machine = this.machine;
    cx.spawn(async cx => {
      for (;;) {
        if (generation !== this.connection) return;
        if (!shown()) { this.clearFlights(); await cx.sleep(500); continue; }
        try {
          if (!this.available(machine)) throw new Error("Machine is offline or its connection is unavailable");
          const data = await readTrace(machine, this.seq, this.connected, { fetch, exec });
          // A switched machine or refreshed source must never receive an old
          // long poll's routes, status, clock skew or error.
          if (generation !== this.connection) return;
          const known = new Set(this.routes.keys()), wasConnected = this.connected;
          if (mergeTrace(this, data)) { this.clearFlights(); this.picked = null; }
          else if (wasConnected) for (const r of data.routes) if (!known.has(r.id)) this.fresh.add(r.id);
          if (this.picked && !this.routes.has(this.picked)) this.picked = null;
          this.skew = Date.parse(data.now) - Date.now(); this.totals = data.totals || {}; this.serves = data.serves; this.connected = true; this.error = null;
          for (const resolve of this.waiters.values()) resolve();
          this.waiters.clear();
          if (shown()) { this.startFlights(cx); this.updateFlow(cx); }
          cx.notify();
        } catch (e) {
          if (generation !== this.connection) return;
          this.connected = false; this.error = String(e); this.clearFlights(); cx.notify(); await cx.sleep(5000);
        }
      }
    });
  }

  close() { ++this.connection; this.clearFlights(); }

  now() { return Date.now() + (Number.isFinite(this.skew) ? this.skew : 0); }
  clearFlights() {
    for (const f of this.flights.values()) f.stopped = true;
    this.flights.clear();
    this.played.clear(); this.fresh.clear(); this.replaying = false; this.flow = null; this.flowKey = null;
    for (const resolve of this.waiters.values()) resolve();
    this.waiters.clear();
  }
  wait(f) { return new Promise(resolve => this.waiters.set(f, resolve)); }
  selected() { return this.picked ? this.routes.get(this.picked) : null; }
  stage() { return staged(this.routes, this.selected(), this.now(), new Set(this.flights.keys())); }
  model() {
    const rs = this.stage(), ids = [...new Set(rs.map(source))];
    const used = new Set(rs.flatMap(r => r.tries.length ? r.tries.map(seat) : r.order.slice(0, 1).map(seat)));
    const ws = seats(rs).filter(w => used.has(seat(w)));
    return { rs, ids, ws, g: geometry(this.width - 54, ids, ws) };
  }
  startFlights(cx) {
    if (this.picked || !this.connected || !shown() || !hostWindow().active) return;
    const ids = new Set(this.stage().map(source));
    for (const r of this.routes.values()) {
      if (this.flights.size >= 4) break;
      if ((r.done && !this.fresh.has(r.id)) || this.flights.has(r.id) || this.played.has(r.id) || !ids.has(source(r))) continue;
      this.played.add(r.id); this.fresh.delete(r.id);
      const f = { id: r.id, from: source(r), tr: null, at: "agent", back: false, held: false, visible: false };
      this.flights.set(r.id, f);
      cx.spawn(async cx => {
        try {
          for (let i = 0; !f.stopped && shown(); i++) {
            let current = this.routes.get(r.id);
            if (!i && current && !current.done && !current.tries.length) {
              await this.travel(f, "hub", 620, cx);
              f.atHub = true; f.held = true; f.visible = true; cx.notify();
              current = this.routes.get(r.id);
            }
            while (current && !current.done && !current.tries[i] && !f.stopped && shown()) { await this.wait(f); current = this.routes.get(r.id); }
            if (!current?.tries[i] || f.stopped) break;
            f.tr = current.tries[i];
            f.back = false; f.held = false;
            await this.travel(f, i || f.atHub ? "retry" : "out", i || f.atHub ? 900 : 1400, cx);
            f.atHub = false;
            if (f.stopped || !shown()) break;
            f.held = true; f.visible = true; cx.notify();
            current = this.routes.get(r.id);
            while (current && !f.stopped && shown() && !current.tries[i]?.done && !current.done) { await this.wait(f); current = this.routes.get(r.id); }
            if (!current || f.stopped || !shown()) break;
            const tr = current.tries[i];
            while (ok(tr) && current && !current.done && !f.stopped && shown()) { await this.wait(f); current = this.routes.get(r.id); }
            if (!current || f.stopped || !shown()) break;
            f.held = false; f.back = true; f.failed = !ok(tr) && !current.canceled;
            if (ok(tr) || current.done) {
              await this.travel(f, "back", ok(tr) ? 1400 : 1350, cx); break;
            }
            await this.travel(f, "retry-back", 620, cx);
          }
        } catch (e) { if (!f.stopped) this.animationError = String(e); }
        finally { if (this.flights.get(r.id) === f) this.flights.delete(r.id); cx.notify(); }
      });
    }
  }
  async clip(spec) {
    const result = await exec(this.python, [appHome() + "/mods/magpie-routing/animate.py", JSON.stringify(spec), appHome()], { timeout: 10000 });
    if (result.code !== 0) throw new Error(result.stderr || "Cannot render Routing animation");
    return JSON.parse(result.stdout);
  }

  updateFlow(cx) {
    if (!shown() || !this.connected || this.picked || !hostWindow().active || this.flowBusy) return;
    const { rs, g } = this.model(), wires = [];
    for (const r of rs) if (!r.done) for (const tr of r.tries.filter(tr => !tr.done)) {
      const a = g.agents.get(source(r)), row = g.rows.get(seat(tr));
      if (a && row && !wires.some(w => w.key === source(r) + seat(tr))) wires.push({ key: source(r) + seat(tr), path: curve(a.x + a.w, a.y + a.h / 2, row.x, row.y + row.h / 2), color: theme().ansi6 });
    }
    const key = JSON.stringify(wires);
    if (key === this.flowKey) return;
    this.flowKey = key; this.flow = null;
    if (!wires.length) { cx.notify(); return; }
    this.flowBusy = true;
    const generation = this.connection;
    cx.spawn(async cx => {
      try {
        const clip = await this.clip({ kind: "flow", wires: wires.map(({ path, color }) => ({ path, color })), duration: 700 });
        if (generation === this.connection && this.flowKey === key && shown() && this.connected && !this.picked && hostWindow().active) this.flow = { ...clip, id: ++this.trip };
      } catch (e) { if (generation === this.connection) this.animationError = String(e); }
      finally { this.flowBusy = false; cx.notify(); }
    });
  }

  async travel(f, kind, ms, cx) {
    if (f.stopped || !shown() || !hostWindow().active) return;
    const { g } = this.model(), paths = way(g, f.from, f.tr ? seat(f.tr) : null, kind), t = theme();
    if (!paths) throw new Error("Routing flight has no matching seat");
    f.visible = false; f.held = false; cx.notify();
    const clip = await this.clip({ kind: "flight", paths, duration: ms, color: t.ansi6, foreground: t.foreground, background: t.surface, back: f.back, error: f.failed ? t.ansi1 : null });
    if (f.stopped || !shown() || !hostWindow().active) return;
    f.clip = { ...clip, id: ++this.trip }; f.visible = true; cx.notify();
    // GPUI loops decoded frames even for a one-shot WebP. Remove during its
    // held final frame, before it can briefly jump back to the departure.
    await cx.sleep(clip.duration - 50);
    f.clip = null; f.visible = false; cx.notify();
  }

  replay(cx) {
    const r = this.selected() || [...this.routes.values()].sort((a, b) => b.id - a.id).find(r => r.done && r.tries.length);
    if (!r?.tries.length || this.replaying || !hostWindow().active) return;
    this.clearFlights(); this.picked = r.id; this.replaying = true;
    const f = { id: r.id, from: source(r), tr: r.tries[0], back: false, held: false, visible: false };
    this.flights.set(r.id, f);
    cx.spawn(async cx => {
      try {
        for (let i = 0; i < r.tries.length && !f.stopped && shown(); i++) {
          f.tr = r.tries[i]; f.back = false; f.failed = false;
          await this.travel(f, i ? "retry" : "out", i ? 900 : 1400, cx);
          if (f.stopped || !shown()) break;
          f.held = true; f.visible = true; cx.notify(); await cx.sleep(Math.min(2500, Math.max(600, (f.tr.ms || 1000) / 8)));
          f.held = false; f.back = true; f.failed = !ok(f.tr) && !r.canceled;
          const last = i === r.tries.length - 1;
          await this.travel(f, last ? "back" : "retry-back", last ? 1400 : 620, cx);
        }
      } catch (e) { if (!f.stopped) this.animationError = String(e); }
      finally {
        if (this.flights.get(r.id) === f) { this.flights.delete(r.id); this.replaying = false; }
        cx.notify();
      }
    });
    cx.notify();
  }

  dot(id, c) {
    return div().id(id).size(6).flex_none().rounded(3).bg(c);
  }
  button(id, icon, action, text) {
    const t = theme();
    return h_flex().id(id).h(25).px(6).gap(5).items_center().rounded(5).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(text).tab_index(0)
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") action(e, cx); })
      .on_mouse_down("left", stop).on_click(action).tooltip(text).child(svg(icon).size(14));
  }
  path(id, points, c, dashed, w, h) {
    const path = PathBuilder.stroke(1.5).move_to(points[0], points[1]);
    if (points.length === 4) path.line_to(points[2], points[3]);
    else path.cubic_bezier_to(points[6], points[7], points[2], points[3], points[4], points[5]);
    if (dashed) path.dash_array([3, 5]);
    return window.paint_path(path.build(), c).id(id).absolute().left(0).top(0).w(w).h(h);
  }

  animated(clip, id) {
    return image(clip.path).id(id + "-" + clip.id).absolute().left(clip.x).top(clip.y).w(clip.width).h(clip.height);
  }

  agentIcon(r, size = 13) {
    return image(ASSETS + `agents/${r.agent === "crush" ? "crush.png" : (NAMES[r.agent] ? r.agent + ".svg" : "generic.svg")}`).size(size).flex_none();
  }

  statusColor(r) {
    const t = theme();
    if (!this.connected && !r.done) return t.dim;
    if (r.canceled) return t.dim;
    if (!r.done) return t.working;
    return r.status >= 400 || r.tries.some(tr => tr.done && !ok(tr)) && !r.tries.some(ok) ? t.ansi1 : t.done;
  }

  drawStage(rs) {
    const t = theme(), { ids, ws, g } = this.model(), hub = g.hub;
    const root = div().id("routing-stage").relative().w(g.width).h(g.height).flex_none();
    for (const w of ws) {
      const box = g.rows.get(seat(w)), state = stateOf(w, rs, this.now()), active = this.connected && ["live", "quiet"].includes(state.kind);
      for (const id of ids) {
        const a = g.agents.get(id), used = rs.some(r => source(r) === id && r.tries.some(tr => seat(tr) === seat(w)));
        const busy = active && rs.some(r => source(r) === id && !r.done && r.tries.some(tr => seat(tr) === seat(w) && !tr.done));
        if (used && !(this.flow && busy)) root.child(this.path(`wire-${id}-${seat(w)}`, curve(a.x + a.w, a.y + a.h / 2, box.x, box.y + box.h / 2), busy ? t.ansi6 : t.border, busy, g.width, g.height));
      }
    }
    if (this.flow && !this.picked) root.child(this.animated(this.flow, "routing-flow"));
    for (const f of this.flights.values()) {
      const r = this.routes.get(f.id), row = f.tr && g.rows.get(seat(f.tr)), a = g.agents.get(f.from);
      if (!r || !f.visible || f.stopped || (this.picked && !this.replaying) || !this.connected || !a) continue;
      if (f.clip) root.child(this.animated(f.clip, `flight-${f.id}`));
      else if (f.held && (row || f.atHub)) root.child(div().id(`packet-${f.id}`).absolute().left((f.atHub ? hub.x : row.x) - 9)
        .top((f.atHub ? a.y + a.h / 2 : row.y + row.h / 2) - 3).size(6).rounded(3).bg(t.ansi6)
        .when(!(r.contentAt && this.now() - r.contentAt > 15000), el => el.loop("opacity", { from: .45, to: 1, period: 1200 })));
    }
    for (const id of ids) {
      const box = g.agents.get(id), r = rs.filter(r => source(r) === id).at(-1);
      root.child(h_flex().absolute().left(box.x).top(box.y).w(box.w).h(box.h).px(8).gap(7).items_center().rounded(6).border(1).border_color(t.border).bg(t.surface)
        .child(this.agentIcon(r)).child(label(NAMES[r.agent] || r.agent, 11, t.foreground).min_w(0).truncate()));
    }
    for (const w of ws) {
      const box = g.rows.get(seat(w)), state = stateOf(w, rs, this.now()), active = this.connected && ["live", "quiet"].includes(state.kind);
      const detail = [destination(w, this.masked), w.model, state.text, w.known ? `${Math.round(w.used)}% used` : ""].filter(Boolean).join(" · ");
      root.child(h_flex().absolute().left(box.x).top(box.y).w(box.w).h(box.h).px(7).gap(6).items_center().rounded(6).border(1).border_color(t.border).bg(t.surface).tooltip(detail)
        .child(this.dot(`seat-dot-${seat(w)}`, active ? t.working : state.kind === "error" || state.kind === "rest" ? t.ansi1 : t.dim))
        .child(label(destination(w, this.masked), 10.5, t.foreground).flex_1().min_w(0).truncate()));
    }
    return root;
  }

  request(r) {
    const t = theme(), tr = r.tries.at(-1), w = tr && [...r.order, ...r.left].find(w => seat(w) === seat(tr));
    const ms = r.done ? r.ms : Math.max(0, this.now() - Date.parse(r.time));
    const stats = [`${r.tries.length} ${r.tries.length === 1 ? "try" : "tries"}`];
    if (r.tokens || r.out || r.estTok) stats.push(`${compact(r.tokens || r.out || r.estTok)} tokens`);
    if (Number.isFinite(ms)) stats.push(`${(ms / 1000).toFixed(1)}s`);
    const pace = speed(r);
    if (pace) stats.push(pace);
    const target = destination(w || { provider: r.provider }, this.masked), model = r.served || tr?.model || "";
    const error = !r.canceled && (r.fail || tr?.fail || tr?.error || (r.status >= 400 ? `HTTP ${r.status}` : ""));
    return v_flex().id(`request-${r.id}`).px(8).py(8).gap(5).rounded(6).min_w(0)
      .bg(this.picked === r.id ? t.selected : t.surface).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.clearFlights(); this.picked = r.id; cx.notify(); })
      .child(h_flex().items_center().gap(7).min_w(0)
        .child(this.agentIcon(r)).child(label(NAMES[r.agent] || r.agent, 13, t.foreground).flex_none())
        .child(label(r.model, 10.5, t.muted).px(5).py(2).rounded(4).bg(t.raised).min_w(0).truncate().tooltip(r.model))
        .child(div().flex_1())
        .when(!r.done, el => el.child(this.dot(`request-dot-${r.id}`, this.statusColor(r))))
        .child(label(time(r.time), 10, t.dim).flex_none()))
      .child(h_flex().pl(20).items_center().gap(5).min_w(0)
        .child(label("→", 11, t.dim)).child(this.dot(`request-seat-${r.id}`, this.statusColor(r)))
        .child(label(target, 11, this.statusColor(r)).max_w(100).truncate().tooltip(target))
        .child(label(`· ${model}`, 10.5, t.muted).min_w(0).truncate().tooltip(model))
        .child(label(stats.join(" · "), 10, t.dim).flex_none().max_w(this.width * .42).truncate().tooltip(stats.join(" · "))))
      .when(Boolean(error), el => el.child(label(error, 10.5, t.ansi1).pl(20).truncate().tooltip(error)))
      .when(Boolean(r.canceled), el => el.child(label("Canceled", 10.5, t.dim).pl(20)));
  }

  machinePicker() {
    const t = theme(), choices = [{ name: null, layout: "ready" }, ...machines().filter(m => m.name !== null)];
    if (!choices.some(m => m.name === this.machine)) choices.push({ name: this.machine, layout: "unavailable" });
    const trigger = h_flex().id("routing-machine-picker").h(25).px(6).gap(5).items_center().flex_1().min_w(0).max_w(160).rounded(5)
      .role("button").accessibility_label("Choose Magpie machine").tab_index(0).hover(s => s.bg(t.hover))
      .tooltip(this.machineName())
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { this.machineMenu = !this.machineMenu; cx.notify(); } })
      .child(this.dot("routing-machine-status", this.available() ? t.accent : t.ansi1))
      .child(label(this.machineName(), 11, t.muted).flex_1().min_w(0).truncate())
      .child(svg(ASSETS + "chevron.svg").size(12).flex_none().text_color(t.muted));
    const menu = v_flex().w(230).max_h(280).overflow_y_scrollbar().p(4).rounded(6).bg(t.popover).border(1).border_color(t.border);
    for (const m of choices) menu.child(h_flex().id(`routing-machine-${m.name ?? "local"}`).h(28).flex_none().px(10).gap(7).items_center().rounded(4)
      .role("button").accessibility_label(`Magpie on ${m.name ?? "This computer"}`).tab_index(0)
      .bg(this.machine === m.name ? t.selected : t.surface).hover(s => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => this.selectMachine(m.name, cx))
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") this.selectMachine(m.name, cx); })
      .child(label(m.name ?? "This computer", 11, t.foreground).flex_1().min_w(0).truncate())
      .child(label(m.layout === "ready" ? this.machine === m.name ? "Selected" : "" : m.layout === "loading" ? "Connecting…" : "Offline", 10, t.dim)));
    return Popover.new("routing-machine-menu").open(this.machineMenu).anchor("top_right")
      .on_open_change((open, cx) => { this.machineMenu = open; cx.notify(); }).trigger(trigger).content(menu);
  }

  render(cx) {
    const space = spaces().find(s => s.active), tab = space?.tabs.find(t => t.active)?.id;
    if (space && (this.space !== space.id || this.tab !== tab)) {
      this.space = space.id; this.tab = tab;
      this.selectMachine(space.machine, cx);
    }
    const t = theme(), all = [...this.routes.values()].sort((a, b) => b.id - a.id), live = all.filter(r => !r.done), recent = all.filter(r => r.done);
    const current = this.selected() || all.find(r => r.done && r.tries.length), rs = this.stage();
    const content = v_flex().id("routing-scroll").absolute().inset_0().overflow_y_scroll().px(10).py(8).gap(4).min_w(0);
    if (this.error) content.child(label(`${this.machineName()} · Magpie unavailable: ${this.error}. Retrying…`, 11, t.ansi1));
    for (const [name, routes] of [["IN FLIGHT", live], ["RECENT", recent]]) {
      content.child(label(`${name}  ${routes.length}`, 10, t.dim).pt(8).pb(4));
      content.children(routes.map(r => this.request(r)));
    }
    if (!all.length && !this.error) content.child(label(`${this.connected ? "Waiting for requests" : "Connecting to Magpie"} · ${this.machineName()} · 127.0.0.1:3425`, 11, t.muted).py(10));
    if (this.animationError) content.child(label(`Animation: ${this.animationError}`, 11, t.ansi1));
    const mode = this.replaying ? "Replay" : this.picked ? "Selected" : `${live.length} live`;
    const footer = `${this.machine === null ? "" : this.machine + " · "}127.0.0.1:3425 · pid ${this.pid || "—"} · ${this.serves || "app"} · ${number(this.totals.requests)} calls · ${number(this.totals.rerouted)} retried`;
    return v_flex().id("routing-root").size_full().min_w(0).bg(t.surface).rounded(10).border(1).border_color(t.border).track_focus(this.handle)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; this.clearFlights(); this.startFlights(cx); this.updateFlow(cx); cx.notify(); } })
      .on_key_down((e, cx) => { if (e.key === "escape") { this.machineMenu = false; this.clearFlights(); this.picked = null; this.startFlights(cx); this.updateFlow(cx); cx.notify(); } })
      .child(h_flex().id("routing-header").h(42).flex_none().min_w(0).px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ASSETS + "routing.svg").size(14).flex_none().text_color(t.muted)).child(label("Magpie", 13, t.foreground).font_semibold().flex_none())
        .child(this.dot("routing-live", this.connected ? live.length ? t.working : t.done : t.dim))
        .child(div().flex_1().min_w(0).when(this.width >= 368, el => el.child(label(mode, 10.5, t.muted))))
        .child(this.machinePicker())
        .when(Boolean(this.picked && current?.tries.length), el => el.child(this.button("routing-replay", ASSETS + "play.svg", (_e, cx) => this.replay(cx), "Replay request")))
        .when(Boolean(this.picked), el => el.child(this.button("back-live", ASSETS + "back.svg", (_e, cx) => { this.clearFlights(); this.picked = null; this.startFlights(cx); this.updateFlow(cx); cx.notify(); }, "Back to live (Escape)")))
        .child(this.button("routing-close", "mods/pane/close.svg", () => run("layout.hide", { id: "panel" }), "Hide Routing")))
      .child(v_flex().flex_none().p(10).child(div().p(15).rounded(12).border(1).border_color(t.border).child(this.drawStage(rs))))
      .child(h_flex().h(28).flex_none().px(14).items_center().border_b(1).border_color(t.border)
        .child(label("REQUESTS", 10, t.dim).flex_1())
        .child(this.button("routing-mask", ASSETS + "mask.svg", (_e, cx) => { this.masked = !this.masked; cx.notify(); }, "Hide account and key names")
          .text_size(10.5).child(this.masked ? "Masked" : "Unmasked")))
      .child(div().relative().flex_1().min_h(0).child(content).child(Scrollbar.vertical("routing-scroll").absolute().inset_0()))
      .child(h_flex().h(30).flex_none().px(12).gap(7).items_center().border_t(1).border_color(t.border)
        .child(this.dot("routing-connection", this.connected ? t.accent : t.ansi1))
        .child(label(footer, 10, t.dim).flex_1().min_w(0).truncate().tooltip(footer))
        .child(this.button("routing-refresh", ASSETS + "refresh.svg", (_e, cx) => this.resetTrace(cx), "Refresh trace")));
  }
}
