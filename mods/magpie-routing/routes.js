// Ported from Magpie's Routing page (MIT, Copyright (c) 2026 yetone).
export const PALETTE = ["#d97757", "#bd8638", "#a59234", "#849e4a", "#5aa66c", "#25a98f", "#00a6b0", "#2e9fc9", "#5e95d7", "#858ad7", "#a47fca", "#bb77b1"];
const HUES = { claude: 0, codex: 9, gemini: 7, copilot: 10, cursor: 5, opencode: 2, crush: 11, goose: 3, pi: 4 };
export const source = r => r.agent + (r.callerKey ? "\u0001" + r.callerKey : "");
export const seat = w => w.id + "\u0001" + (w.model || "");
export const ok = tr => tr.status > 0 && tr.status < 400 && !tr.fail && !tr.error;
export const whole = r => ({ ...r, order: r.order || [], left: r.left || [], tries: r.tries || [] });
export const destination = (w, masked) => `${w.name || w.provider || "routing…"}${w.who && w.kind !== "provider" ? " · " + (masked ? "••••" : w.who) : ""}`;

// Magpie's rowSpeed: exclude reasoning and burst replies, use a lower bound when needed.
export function speed(r) {
  if (!r.done || r.canceled || r.status >= 400) return "";
  const think = r.reasoning || 0, ttft = r.ttft || 0;
  const visible = think > 0 && !(r.firstText > 0) && r.firstReasoning >= ttft && r.flow > 0 && think <= r.out;
  const n = think > 0 && !visible ? r.out - think : r.out;
  const from = visible ? r.firstReasoning : think > 0 ? r.firstText : ttft, w = r.ms - from;
  if (!(r.reasoningHidden && !(r.firstText > 0)) && n > 0 && ttft > 0 && from > 0 && w >= 100 && n * 1000 <= 10000 * w
      && !(r.flow > 0 && r.flow * 4 < w) && !(w < 1000 && from > 4 * w)
      && !(think > 0 && r.firstText > 0 && n * (r.firstText - ttft) > 20 * think * w)) return `${Math.round(n * 1000 / w)} tok/s`;
  const answer = (r.out || 0) - think, after = r.ms - ttft;
  if (ttft > 0 && think > 0 && !(r.firstText > 0) && answer >= 100 && after >= 1000
      && answer * 1000 <= 10000 * after && !(r.flow > 0 && r.flow * 4 < after)) return `≥${Math.round(answer * 1000 / after)} tok/s`;
  return r.out >= 1000 && r.ms >= 1000 && r.out * 1000 <= 10000 * r.ms ? `≥${Math.round(r.out * 1000 / r.ms)} tok/s` : "";
}

export function color(id, given, near = new Set()) {
  const kept = given.get(id);
  if (kept && !near.has(kept)) return kept;
  let h = HUES[id.split("\u0001")[0]];
  if (h == null) { h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; }
  const had = new Set(given.values()), from = k => PALETTE[(h + k) % PALETTE.length];
  const keys = PALETTE.map((_, i) => i);
  const c = from(keys.find(k => !had.has(from(k)) && !near.has(from(k))) ?? keys.find(k => !near.has(from(k))) ?? 0);
  given.set(id, c);
  return c;
}

export function mergeTrace(state, data) {
  if (data?.object !== "trace" || !Number.isFinite(data.seq) || !Array.isArray(data.routes)
      || data.routes.some(r => !r || !Number.isFinite(r.id) || typeof r.agent !== "string" || typeof r.done !== "boolean"
        || [r.order, r.left, r.tries].some(xs => xs != null && (!Array.isArray(xs) || xs.some(x => !x || typeof x.id !== "string"))))) {
    throw new Error("Invalid Magpie trace response");
  }
  const reset = state.pid !== data.pid || data.seq < state.seq;
  if (reset) state.routes.clear();
  for (const r of data.routes) state.routes.set(r.id, whole(r));
  if (Array.isArray(data.ids)) {
    const kept = new Set(data.ids);
    for (const [id, r] of state.routes) if (!r.done && !kept.has(id)) state.routes.delete(id);
  }
  for (const id of [...state.routes.keys()].sort((a, b) => a - b).slice(0, -60)) state.routes.delete(id);
  state.pid = data.pid; state.seq = data.seq;
  return reset;
}

export function staged(routes, picked, now, playing = new Set()) {
  if (picked) return [picked];
  const rs = [...routes.values()].sort((a, b) => a.id - b.id), last = new Map();
  for (const r of rs) last.set(source(r), r);
  const out = rs.filter(r => playing.has(r.id) || !r.done || (last.get(source(r)) === r && Date.parse(r.time) + (r.ms || 0) > now - 12000));
  const current = rs.at(-1);
  if (current && !out.includes(current)) out.push(current);
  const ids = [...new Set(out.map(source))].slice(-4);
  return out.filter(r => ids.includes(source(r)));
}

export function seats(rs) {
  const out = new Map();
  for (const r of rs) {
    for (const w of [...r.order, ...r.left]) if (!w.held && !w.barred) out.set(seat(w), w);
    for (const tr of r.tries) if (!out.has(seat(tr))) out.set(seat(tr), { ...tr, provider: r.provider, name: r.provider });
  }
  return [...out.values()];
}

export function stateOf(w, rs, now) {
  const live = rs.find(r => !r.done && r.tries.some(tr => seat(tr) === seat(w) && !tr.done));
  if (live) {
    const quiet = live.contentAt && now - live.contentAt > 15000;
    return { kind: quiet ? "quiet" : "live", route: live, text: quiet ? "Waiting for content…" : live.contentAt ? "Answering…" : "Waiting for first token…" };
  }
  for (const r of [...rs].reverse()) {
    const tr = r.tries.filter(tr => seat(tr) === seat(w)).at(-1);
    if (tr) return { kind: r.canceled || tr.gone ? "canceled" : ok(tr) ? "done" : "error", route: r, text: r.canceled || tr.gone ? "Canceled" : ok(tr) ? "Answered" : `${tr.status || "Error"} · ${tr.fail || tr.error || "failed"}` };
  }
  return { kind: w.rest ? "rest" : "idle", text: w.rest ? "Resting" : w.capped ? "At usage cap" : w.window ? "Context too long" : w.kind === "account" ? w.plan || "Available" : "Available" };
}

// The video fans routes directly out of each Agent; magpie is not a visible node.
export function geometry(width, ids, ws) {
  width = Math.max(180, width);
  const agentW = Math.min(112, width * .31), rowW = agentW, rowH = 24;
  const height = Math.max(36, ids.length * 29 - 5, ws.length * 29 - 5);
  const agents = new Map(ids.map((id, i) => [id, { x: 0, y: 4 + i * 29, w: agentW, h: rowH }]));
  const hub = { x: agentW + 12, y: 4, w: 0, h: rowH };
  const rows = new Map(ws.map((w, i) => [seat(w), { x: width - rowW, y: 4 + i * 29, w: rowW, h: rowH }]));
  return { width, height, agents, hub, rows };
}

export function curve(x0, y0, x1, y1) {
  const mid = (x0 + x1) / 2;
  return [x0, y0, mid, y0, mid, y1, x1, y1];
}

export function way(g, from, key, kind = "out") {
  const a = g.agents.get(from), w = g.rows.get(key), h = g.hub;
  if (!a || (kind !== "hub" && !w)) return null;
  const path = kind === "hub" ? curve(a.x + a.w, a.y + a.h / 2, h.x, a.y + a.h / 2)
    : curve(kind === "out" || kind === "back" ? a.x + a.w : h.x, a.y + a.h / 2, w.x, w.y + w.h / 2);
  if (kind === "back" || kind === "retry-back") return [[...path.slice(6), ...path.slice(4, 6), ...path.slice(2, 4), ...path.slice(0, 2)]];
  return [path];
}

export function stableSeats(rs, previous = []) {
  const ws = seats(rs), latest = new Map(ws.map(w => [seat(w), w]));
  const ids = [...previous.filter(id => latest.has(id)), ...ws.map(seat).filter(id => !previous.includes(id))];
  return ids.map(id => latest.get(id));
}
