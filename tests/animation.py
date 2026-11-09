import importlib.util
from pathlib import Path
import tempfile

from PIL import Image, ImageChops

file = Path(__file__).resolve().parents[1] / "mods/magpie-routing/animate.py"
module = importlib.util.spec_from_file_location("animate", file)
animate = importlib.util.module_from_spec(module)
module.loader.exec_module(animate)
assert len(animate.LOGO) == 3, "Round Magpie logo retains its two even-odd holes"

spec = {"kind": "flight", "paths": [[112, 24, 142, 24, 142, 45, 172, 45], [172, 45, 210, 45], [210, 45, 248, 45, 248, 85, 286, 85]],
        "duration": 1400, "color": "#858ad7", "foreground": "#eeeeee", "background": "#222222"}
pts, distances = animate.measure(spec["paths"])
assert distances[-1] > 174, "Use curve arc length rather than x distance"
assert animate.along(pts, distances, -1) == pts[0]
assert animate.along(pts, distances, distances[-1] + 1) == pts[-1]
wing_frames = []
for ms in (0, 100, 230, 350):
    frame = Image.new("RGBA", (100, 100))
    animate.bird(frame, (44, 35), 1, 0, 420 + ms, spec, (0, 0))
    wing_frames.append(frame.tobytes())
assert len(set(wing_frames)) == 4, "420ms wing cycle needs distinct poses"

with tempfile.TemporaryDirectory() as temp:
    folder = Path(temp)
    clip = animate.render(spec, folder)
    assert clip["duration"] == 1950, "Flight, 450ms departure, then 100ms held tail"
    im = Image.open(folder / Path(clip["path"]).name)
    assert im.n_frames >= 100, "Flight is encoded at approximately 60fps"
    first = im.convert("RGBA")
    im.seek(42)
    middle = im.convert("RGBA")
    im.seek(im.n_frames - 1)
    last = im.convert("RGBA")
    assert first.getpixel((0, 0))[3] == 0
    assert ImageChops.difference(first, middle).getbbox()
    assert ImageChops.difference(middle, last).getbbox()
    for frame, d in ((first, 6), (last, distances[-1] - 6)):
        x, y = animate.along(pts, distances, d)
        color = frame.getpixel((round(x - clip["x"]), round(y - clip["y"])))
        assert max(abs(a - b) for a, b in zip(color[:3], (133, 138, 215))) <= 4 and color[3] > 240
    x, y = animate.along(pts, distances, distances[-1] - 6)
    assert last.crop((0, 0, round(x - clip["x"] - 7), clip["height"])).getbbox() is None, "Bird departs; packet alone stays at the seat"
    assert animate.render(spec, folder) == clip
    back = {**spec, "back": True, "error": "#ff4433", "paths": [list(p[-2:]) + list(p[4:6]) + list(p[2:4]) + list(p[:2]) if len(p) == 8 else p[2:] + p[:2] for p in reversed(spec["paths"])]}
    back_clip = animate.render(back, folder)
    back_im = Image.open(folder / Path(back_clip["path"]).name)
    back_im.seek(back_im.n_frames - 1)
    frame = back_im.convert("RGBA")
    x, y = animate.along(*animate.measure(back["paths"]), animate.measure(back["paths"])[1][-1] - 6)
    cx, cy = round(x - back_clip["x"]), round(y - back_clip["y"])
    assert max(frame.getpixel((cx, cy))[:3]) < 80, "Response ring has a dark open center after downsampling"
    assert frame.getpixel((cx + 2, cy))[0] > 180, "Failed response retains a red ring edge"
    flow = animate.render({"kind": "flow", "wires": [{"path": spec["paths"][0], "color": "#858ad7"}], "duration": 700}, folder)
    im = Image.open(folder / Path(flow["path"]).name)
    assert im.n_frames == 42
    first = im.convert("RGBA")
    im.seek(21)
    assert ImageChops.difference(first, im.convert("RGBA")).getbbox(), "3/5 dashes move 8px each 700ms"
    assert flow["width"] < clip["width"]
    for bad in ({**spec, "duration": float("inf")}, {**spec, "paths": [[0, 0, 1, float("nan")]]}, {**spec, "color": "transparent"}):
        try:
            animate.render(bad, folder)
            raise AssertionError("Invalid animation spec accepted")
        except ValueError:
            pass
print("Animation self-check passed (60fps clips, round Magpie logo, S-curve arc length, 6px edges, wing phases, arrival/departure, response ring, flowing dashes, cache; native playback not simulated).")
