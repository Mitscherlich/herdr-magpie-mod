#!/usr/bin/env python3
"""Bake Magpie's flight/flow into transparent WebP; GPUI owns frame playback."""
import bisect
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops, ImageDraw

SCALE = 2
# The video uses a compact packet beside a 26px copy of Magpie's round logo.
COMPACT = .65


def point(p, t):
    if len(p) == 4:
        return p[0] + (p[2] - p[0]) * t, p[1] + (p[3] - p[1]) * t
    u = 1 - t
    return tuple(u**3 * p[k] + 3 * u*u*t * p[k + 2] + 3 * u*t*t * p[k + 4] + t**3 * p[k + 6] for k in (0, 1))


def measure(paths):
    points, distances, distance = [], [], 0
    for p in paths:
        for i in range(161):
            at = point(p, i / 160)
            if points:
                distance += math.dist(points[-1], at)
            points.append(at)
            distances.append(distance)
    return points, distances


def along(points, distances, d):
    d = max(0, min(distances[-1], d))
    i = min(len(points) - 1, bisect.bisect_left(distances, d))
    if not i:
        return points[0]
    lo, hi = distances[i - 1], distances[i]
    t = (d - lo) / (hi - lo) if hi > lo else 0
    return tuple(a + (b - a) * t for a, b in zip(points[i - 1], points[i]))


def logo_paths():
    # The bundled logo only uses absolute M/C/Z; retain its three even-odd contours.
    svg = ET.parse(Path(__file__).with_name("magpie.svg"))
    tokens = re.findall(r"[MCZ]|-?\d+(?:\.\d+)?", svg.find("{http://www.w3.org/2000/svg}path").attrib["d"])
    contours, contour, current, i = [], [], None, 0
    while i < len(tokens):
        command = tokens[i]
        i += 1
        if command == "M":
            current = tuple(float(v) for v in tokens[i:i + 2])
            contour = [current]
            i += 2
        elif command == "C":
            values = [float(v) for v in tokens[i:i + 6]]
            contour.extend(point([*current, *values], n / 8) for n in range(1, 9))
            current = tuple(values[-2:])
            i += 6
        elif command == "Z":
            contours.append(contour)
        else:
            raise ValueError("Bundled Magpie logo needs absolute M/C/Z paths")
    return contours


LOGO = logo_paths()


def rgba(c, opacity=1):
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(x * 2 for x in c)
    rgb = tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    return (*rgb, round((int(c[6:8], 16) if len(c) == 8 else 255) * opacity))


def wing_ease(t):
    # CSS cubic-bezier(.45, 0, .3, 1), applied to both rtflap keyframe legs.
    lo, hi = 0, 1
    for _ in range(18):
        s = (lo + hi) / 2
        x = 3 * (1 - s)**2 * s * .45 + 3 * (1 - s) * s*s * .3 + s**3
        if x < t:
            lo = s
        else:
            hi = s
    return 3 * (1 - s) * s*s + s**3


def bird(frame, at, flip, angle, ms, spec, origin):
    away = max(0, min(1, (ms - spec["duration"]) / 450))
    away = 1 - (1 - away)**3
    come = max(0, 1 - min(1, ms / 300))**3 if not away else 0
    size, opacity = 1 - .2 * away - .15 * come, 1 - away
    a = math.radians(angle)

    def coords(points):
        phase = (ms % 420) / 420
        beat = wing_ease(phase / .55) if phase < .55 else 1 - wing_ease((phase - .55) / .45)
        result = []
        for x, y in points:
            if x < 17 and y < 26:
                x += math.tan(math.radians(-8)) * beat * (y - 23)
                y = 23 + (y - 23) * (1 - 1.62 * beat)
            x, y = ((x - 22) * 26 / 44 * size - 16 + (14 * away - 6 * come) * COMPACT,
                    (y - 22) * 26 / 44 * size + (-16 * away - 10 * come) * COMPACT)
            x, y = flip * (x * math.cos(a) - y * math.sin(a)), x * math.sin(a) + y * math.cos(a)
            result.append(((at[0] + x - origin[0]) * SCALE, (at[1] + y - origin[1]) * SCALE))
        return result

    mask = Image.new("L", frame.size)
    for contour in LOGO:
        part = Image.new("L", frame.size)
        ImageDraw.Draw(part).polygon(coords(contour), fill=255)
        mask = ImageChops.difference(mask, part)
    if opacity < 1:
        mask = mask.point(lambda v: round(v * opacity))
    ink = Image.new("RGBA", frame.size, rgba(spec["foreground"]))
    ink.putalpha(mask)
    frame.alpha_composite(ink)


def validate(spec):
    if not isinstance(spec, dict) or spec.get("kind") not in ("flight", "flow"):
        raise ValueError("Expected a flight or flow animation")
    duration = spec.get("duration", 700)
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 100 <= duration <= 5000:
        raise ValueError("Animation duration must be 100–5000 ms")
    spec = {**spec, "duration": duration}
    wires = spec.get("wires") if spec["kind"] == "flow" else [{"path": p, "color": spec.get("color")} for p in spec.get("paths", [])]
    if not isinstance(wires, list) or not 1 <= len(wires) <= 64:
        raise ValueError("Expected 1–64 route paths")
    for wire in wires:
        p = wire.get("path") if isinstance(wire, dict) else None
        if not isinstance(p, list) or len(p) not in (4, 8) or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 10000 for v in p):
            raise ValueError("Route paths need four or eight finite coordinates")
    colors = [w.get("color") for w in wires]
    if spec["kind"] == "flight":
        colors += [spec.get("foreground"), spec.get("background")]
        if spec.get("error"):
            colors.append(spec["error"])
    if any(not isinstance(c, str) or not re.fullmatch(r"#(?:[\da-fA-F]{3}|[\da-fA-F]{6}|[\da-fA-F]{8})", c) for c in colors):
        raise ValueError("Animation colors must be hexadecimal")
    return spec, wires


def render(spec, folder):
    spec, wires = validate(spec)
    paths = [w["path"] for w in wires]
    points = [point(p, i / 40) for p in paths for i in range(41)]
    margin = 54 if spec["kind"] == "flight" else 3
    x, y = (math.floor(min(p[k] for p in points) - margin) for k in (0, 1))
    width = math.ceil(max(p[0] for p in points) - x + margin)
    height = math.ceil(max(p[1] for p in points) - y + margin)
    if width > 4096 or height > 4096 or width * height > 1000000:
        raise ValueError("Animation route is too large")
    key = hashlib.sha256(("magpie-logo-flight-v5:" + json.dumps(spec, sort_keys=True)).encode()).hexdigest()[:24]
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{key}.webp"
    travel = spec["duration"]
    duration = travel + 550 if spec["kind"] == "flight" else travel
    out = {"path": f"data/magpie-routing/{target.name}", "x": x, "y": y, "width": width, "height": height, "duration": duration}
    if target.exists():
        os.utime(target, None)
        return out
    tracks = [measure([p]) for p in paths] if spec["kind"] == "flow" else [measure(paths)]
    frames, durations, angle = [], [], None
    span = travel + 450 if spec["kind"] == "flight" else travel
    count = max(2, math.ceil(span * 60 / 1000)) + (spec["kind"] == "flight")
    step = span / (count - 1 if spec["kind"] == "flight" else count)
    for i in range(count):
        ms = i * step
        frame = Image.new("RGBA", (width * SCALE, height * SCALE))
        draw = ImageDraw.Draw(frame)
        if spec["kind"] == "flow":
            for wire, (pts, distances) in zip(wires, tracks):
                d = -8 + 8 * ms / travel
                while d < distances[-1]:
                    lo, hi = max(0, d), min(distances[-1], d + 3)
                    if hi > lo:
                        section = [along(pts, distances, lo + (hi - lo) * j / 3) for j in range(4)]
                        draw.line([((px - x) * SCALE, (py - y) * SCALE) for px, py in section], fill=rgba(wire["color"]), width=3)
                    d += 8
        else:
            pts, distances = tracks[0]
            edge = min(6, distances[-1] / 4)
            e = (1 - math.cos(math.pi * min(1, ms / travel))) / 2
            d = edge + e * (distances[-1] - 2 * edge)
            at = along(pts, distances, d)
            p0, p1 = along(pts, distances, d - 3), along(pts, distances, d + 3)
            vx, vy = p1[0] - p0[0], p1[1] - p0[1]
            aim = max(-24, min(24, math.degrees(math.atan2(vy, abs(vx)))))
            angle = aim if angle is None else angle + (aim - angle) * .12
            bird(frame, at, -1 if spec.get("back") else 1, angle, ms, spec, (x, y))
            draw = ImageDraw.Draw(frame)
            cx, cy = (at[0] - x) * SCALE, (at[1] - y) * SCALE
            radius = (4 if spec.get("back") else 4.5) * SCALE * COMPACT
            box = (cx - radius, cy - radius, cx + radius, cy + radius)
            fill = spec["background"] if spec.get("back") else spec["color"]
            outline = spec.get("error") or spec["color"] if spec.get("back") else None
            draw.ellipse(box, fill=rgba(fill), outline=rgba(outline) if outline else None, width=round(2.25 * SCALE * COMPACT))
        frames.append(frame.resize((width, height), Image.Resampling.LANCZOS))
        durations.append(round((i + 1) * step) - round(i * step))
    if spec["kind"] == "flight":
        durations[-1] = 100
    tmp = folder / f"{key}.{os.getpid()}.tmp"
    frames[0].save(tmp, format="WEBP", save_all=True, append_images=frames[1:], duration=durations, loop=0, lossless=True, minimize_size=False)
    tmp.replace(target)
    for old in sorted(folder.glob("*.webp"), key=lambda p: p.stat().st_mtime, reverse=True)[128:]:
        if time.time() - old.stat().st_mtime > 600:
            old.unlink(missing_ok=True)
    return out


if __name__ == "__main__":
    print(json.dumps(render(json.loads(sys.argv[1]), Path(sys.argv[2]) / "data/magpie-routing")))
