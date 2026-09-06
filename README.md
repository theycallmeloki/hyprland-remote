# hyprland-remote

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
- **`apps`** (top bar) — launch any installed application (XDG desktop
  entries, filterable list)
- **`⌨`** (top bar) — type into the focused window, with `esc` / `tab` / `↵`
  keys for the desktop app

State refreshes every ~1 s, so the page follows the desktop live. Launches
and keystrokes run through Hyprland's own `exec_cmd`, so apps and `wtype`
inherit the compositor's environment.

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

Needs Node ≥ 22, plus `gtk-launch` (app launching) and `wtype` (typing) on
the machine. Start it from a terminal inside your Hyprland session:

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

### Run as a systemd user service

So it starts and stops with your graphical session:

```sh
cp omarchy-remote.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now omarchy-remote.service
journalctl --user -u omarchy-remote -f   # logs
```

Edit the `ExecStart` node path in the unit if your Node lives elsewhere.

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
server.mjs              Node server: Hyprland socket client + token-guarded HTTP
public/index.html       the panel — no framework, no dependencies
omarchy-remote.service  systemd user unit (see "Run as a systemd user service")
```
