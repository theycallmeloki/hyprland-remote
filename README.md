# omarchy-remote

A phone-sized control panel for an [Omarchy](https://omarchy.org/) desktop's
monitors and windows. Zero dependencies — a single Node server and one HTML
page. No extra daemons, no build step.

## What it does

The page shows one column per monitor, left to right in your physical layout.
Each column lists the windows on that monitor (most recently focused first).

- **Tap a window** — focus it on the desktop
- **`◂` / `▸`** — move that window to the neighboring monitor
- **`⛶`** — toggle fullscreen
- **`⤢`** — toggle floating
- **`✕`** — close the window
- **`focus`** (column header) — focus that monitor

State refreshes every ~1 s, so the page follows the desktop live.

## How it works

It talks to Hyprland directly over its request socket (`.socket.sock`):

- state comes from `j/monitors` and `j/clients`
- every action is a Lua dispatcher expression evaluated as
  `hl.dispatch(<expr>)` — the same constructors Omarchy's own bindings use
  (e.g. `hl.dsp.window.move({ window = "address:0x…", monitor = "DP-1" })`)

Nothing sent by the browser ever reaches a shell. Only validated window
addresses (`0x…`) and known monitor names are interpolated, and actions are a
fixed closed set.

This works on Hyprland's Lua-config generation (Hyprland ≥ 0.55, Omarchy 4).

## Run it

Needs Node ≥ 22. Start it from a terminal inside your Hyprland session:

```sh
node server.mjs
```

It prints two URLs — one for localhost, one for your LAN IP:

```
omarchy-remote on http://127.0.0.1:8791/?t=milady
phone:      http://192.168.1.147:8791/?t=milady
```

Open the LAN URL on your phone (same Wi-Fi), or save it as a home-screen
shortcut. Port defaults to 8791; override with `--port` / `--host`.

## Change the token

The default access token is `milady`. **Change it before exposing this on a
network you do not fully trust** — anyone with the token can move, focus,
fullscreen, float and close windows on the machine.

```sh
OMARCHY_REMOTE_TOKEN=your-own-secret node server.mjs
```

The token is required on every request (`?t=<token>` query or `x-token`
header). The LAN is not a trust boundary: the server itself does nothing to
authenticate the network, so also consider a firewall rule scoped to your
subnet (example for ufw):

```sh
sudo ufw allow from 192.168.1.0/24 to any port 8791 proto tcp
```

## Layout

```
server.mjs            Node server: Hyprland socket client + token-guarded HTTP
public/index.html     the panel — no framework, no dependencies
```
