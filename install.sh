#!/bin/sh
set -eu
cd "$(dirname "$0")"
app_config="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
test -d "$app_config" || { echo "Herdr config directory not found: $app_config" >&2; exit 1; }

# Accept only this project's files or untouched clones made for this install.
node --input-type=module - "$app_config" <<'JS'
import { existsSync as exists, readFileSync as read } from "node:fs";
const home = process.argv[2];
for (const name of ["magpie-routing", "magpie-tabs"]) {
  const folder = `${home}/mods/${name}`;
  if (!exists(folder) || exists(`${folder}/.herdr-magpie-mod`)) continue;
  const clone = name === "magpie-tabs" && JSON.parse(read(`${folder}/mod.json`)).cloned_from?.name === "tabs";
  const original = clone && read(`${home}/mods/tabs/main.js`, "utf8").replaceAll("mods/tabs/", "mods/magpie-tabs/");
  if (!clone || read(`${folder}/main.js`, "utf8") !== original) throw new Error(`Refusing to overwrite existing mod: ${folder}`);
}
const file = `${home}/layouts/Magpie.json`;
if (exists(file) && JSON.parse(read(file)).cloned_from?.name !== "main") throw new Error(`Refusing to overwrite existing layout: ${file}`);
JS

node tests/routes.mjs
node tests/trace.mjs
node tests/render.mjs
python="$(command -v python3)"
"$python" -c 'from PIL import features; assert features.check("webp_anim"), "Pillow needs animated WebP support"'
"$python" -B tests/animation.py
herdr-app check "$PWD/mods/magpie-routing"
herdr-app check "$PWD/mods/magpie-tabs"
for name in magpie-routing magpie-tabs; do
  mkdir -p "$app_config/mods/$name"
  cp -R "mods/$name/." "$app_config/mods/$name/"
  cp LICENSE "$app_config/mods/$name/PROJECT-LICENSE"
  cp 3rd-party-license.md "$app_config/mods/$name/"
  touch "$app_config/mods/$name/.herdr-magpie-mod"
done
rm -f "$app_config/mods/magpie-routing/fonts/magpie-routing-motion.ttf" "$app_config/mods/magpie-routing/fonts/magpie-routing-bird.ttf"
cp layouts/Magpie.svg layouts/Magpie.json.license "$app_config/layouts/"
if [ ! -f "$app_config/layouts/Magpie.json" ]; then
  herdr-app do layout.clone '{"name":"main","as":"Magpie"}'
  herdr-app do layout.set --layout "$(cat layouts/Magpie.json)"
else
  herdr-app do layout.switch '{"name":"Magpie"}'
  herdr-app do layout.set --layout "$(cat layouts/Magpie.json)"
fi
# Keep the existing clone and its look; only supply this mod's Python executable.
node --input-type=module - "$app_config" "$python" <<'JS'
import { readFileSync, writeFileSync, renameSync } from "node:fs";
const file = `${process.argv[2]}/layouts/Magpie.json`, layout = JSON.parse(readFileSync(file));
function visit(node) {
  if (node.id === "routing") node.content.props = { python: process.argv[3] };
  for (const child of node.children || []) visit(child);
}
visit(layout);
writeFileSync(file + ".tmp", JSON.stringify(layout, null, 2) + "\n");
renameSync(file + ".tmp", file);
JS
herdr-app do layout.resize '{"id":"panel","px":420}'
herdr-app do layout.select '{"stack":"panel-body","child":"routing"}'
herdr-app do layout.show '{"id":"panel"}'
# Drop earlier names of this layout once Magpie is showing.
node --input-type=module - "$app_config" <<'JS'
import { existsSync as exists, readFileSync as read, rmSync } from "node:fs";
const home = process.argv[2];
for (const name of ["magpie-routing", "Custom"]) {
  const file = `${home}/layouts/${name}.json`;
  if (!exists(file)) continue;
  const layout = JSON.parse(read(file, "utf8"));
  if (layout.cloned_from?.name !== "main" || !JSON.stringify(layout).includes("magpie-routing")) continue;
  for (const path of [file, `${home}/layouts/${name}.svg`, `${home}/layouts/${name}.json.license`, `${home}/layouts/.state/${name}.json`]) {
    if (exists(path)) rmSync(path);
  }
}
JS
herdr-app status
