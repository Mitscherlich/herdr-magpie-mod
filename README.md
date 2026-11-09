# Herdr Magpie Routing

A live [Magpie](https://github.com/yetone/magpie) routing panel for [Herdr](https://herdr.dev/).

## Installation

Requirements:

- Herdr running, with `herdr-app` available on your PATH.
- Magpie running on each machine you want to inspect, with its trace endpoint on `127.0.0.1:3425`.
- Node.js, Python 3, and Pillow with animated WebP support on this computer.
- `curl` on any remote machine you want to inspect.

From the project directory, run:

```sh
sh install.sh
```

The installer runs the self-checks and native mod checks, then installs the two mods and a cloned layout. It checks ownership before replacing existing files and preserves the clone's theme and per-space panel choices. Dependencies are not downloaded automatically.

The install location is `HERDR_APP_HOME`, or `~/.config/herdr-app` by default. The Python executable is detected locally and recorded in the installed layout.

Click **Routing** next to **Files** and **Changes** to open the panel. The machine picker follows the active session; a manual selection lasts until you switch sessions.

To return to Herdr's default layout:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

## Privacy

This plugin reads the selected machine's Magpie trace at `http://127.0.0.1:3425/v1/magpie/trace`. Remote reads run `curl` on that machine through Herdr's existing connection. No port forwarding or public endpoint is needed. The plugin does not implement telemetry or upload traces to third parties; Herdr and Magpie have their own privacy settings.

Trace snapshots stay in memory. Generated WebP files are cached locally under `data/magpie-routing/` in the Herdr configuration directory; raw traces are not written to that cache. The animation process receives drawing data without account or caller identifiers.

**Masked** hides account and key `who` labels. Machine names, provider names, model names, and error details can still contain personal information. Review these fields before sharing screenshots.

Environment files, caches, logs, and Python bytecode are excluded by `.gitignore`. Personal Herdr configuration and real request captures are not part of the source distribution.

## License

Original contributions are licensed under the [MIT License](LICENSE).

Third-party code and assets retain their respective licenses. See [Third-party licenses](3rd-party-license.md) for the component list, attribution, and license texts.
