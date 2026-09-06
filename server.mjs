// omarchy-remote — a phone-sized control panel for Hyprland monitors.
// Zero dependencies. Node >= 22.
//
//   node server.mjs            # serve on 0.0.0.0:8791
//   node server.mjs --port N --host 0.0.0.0
//
// Talks to Hyprland's request socket (.socket.sock) exactly the way
// Omarchy's own scripts do: queries are j/<cmd>, actions are Lua dispatcher
// expressions evaluated as hl.dispatch(<expr>). No command string from the
// phone ever reaches a shell; only validated ids/names are interpolated.
//
// A random token is printed at startup and required on every request
// (?t=...). The LAN is not a trust boundary — run it on a network you
// trust, or bind --host to a specific address.

import http from "node:http";
import net from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);

const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const PORT = Number(flag("--port", "8791"));
const HOST = flag("--host", "0.0.0.0");
const TOKEN = process.env.OMARCHY_REMOTE_TOKEN || "milady";

// --- Hyprland request socket -------------------------------------------------

function hyprDir() {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
  const base = join(runtime, "hypr");
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (sig) return join(base, sig);
  const entries = readdirSync(base).filter((e) => !e.startsWith("."));
  if (entries.length === 0) throw new Error(`no Hyprland instance under ${base}`);
  entries.sort((a, b) => Number(b.split("_")[1] ?? 0) - Number(a.split("_")[1] ?? 0));
  return join(base, entries[0]);
}

let awaitImportFs = null; // hoisted helper (see below)
function hypr(command, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(join(hyprDir(), ".socket.sock"));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`hypr ${command}: timeout`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(command));
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

const hyprJson = async (cmd) => JSON.parse(await hypr(`j/${cmd}`));
const dispatch = async (lua) => {
  const reply = (await hypr(`dispatch ${lua}`)).trim();
  if (reply !== "ok") throw new Error(`dispatch ${lua}: ${reply}`);
};

// --- state -------------------------------------------------------------------

async function getState() {
  const [monitors, clients, active] = await Promise.all([
    hyprJson("monitors"),
    hyprJson("clients"),
    hyprJson("activewindow"),
  ]);
  monitors.sort((a, b) => a.x - b.x);
  return {
    monitors: monitors.map((m) => ({
      id: m.id,
      name: m.name,
      x: m.x,
      w: m.width,
      h: m.height,
      focused: m.focused,
      ws: m.activeWorkspace.id,
    })),
    clients: clients
      .slice()
      .sort((a, b) => (a.focusHistoryID ?? 1e9) - (b.focusHistoryID ?? 1e9))
      .map((c) => ({
        address: c.address,
        class: c.class,
        title: c.title,
        monitor: c.monitor,
        floating: c.floating,
        fullscreen: c.fullscreen !== 0,
      })),
    focused: active?.address ?? null,
  };
}

// --- actions (validated ids/names only) --------------------------------------

const ADDR = /^0x[0-9a-f]+$/;
const APP_ID = /^[A-Za-z0-9_.-]+$/;

/** Shell-single-quote a string (safe inside `sh -c`). */
function shq(s) {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** Quote a string as a Lua double-quoted literal for `hl.dsp.exec_cmd(...)`. */
function luaStr(s) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}

/** The desktop entries a windowing app can launch: user dir first, then
 *  system; first file of a given id wins (override semantics). */
function listApps() {
  const dirs = [join(os.homedir(), ".local/share/applications"), "/usr/share/applications"];
  const apps = [];
  const seen = new Set();
  for (const dir of dirs) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const f of files) {
      const id = f.slice(0, -".desktop".length);
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const entry = {};
        let inEntry = false;
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          const t = line.trim();
          if (t.startsWith("[")) { inEntry = t === "[Desktop Entry]"; continue; }
          if (!inEntry) continue;
          const eq = t.indexOf("=");
          if (eq < 0) continue;
          entry[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
        }
        if (entry.Type !== undefined && entry.Type !== "Application") continue;
        if (!entry.Exec || entry.NoDisplay === "true" || entry.Hidden === "true") continue;
        apps.push({ id, name: entry.Name || id });
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

// --- MPRIS (media players on the session bus) --------------------------------

const MPRIS_RE = /^org\.mpris\.MediaPlayer2\.[A-Za-z0-9_.-]+$/;
const MEDIA_METHODS = { playpause: "PlayPause", next: "Next", prev: "Previous", stop: "Stop" };

async function mprisPlayers() {
  const { stdout } = await run("busctl", ["--user", "list"]);
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((name) => MPRIS_RE.test(name))
    .sort();
}

async function doAction(body) {
  const op = body.op;
  const addr = (s) => (typeof s === "string" && ADDR.test(s) ? s : null);

  switch (op) {
    case "focusMonitor": {
      const name = body.name;
      const monitors = await hyprJson("monitors");
      if (typeof name !== "string" || !monitors.some((m) => m.name === name)) throw new Error("bad monitor");
      await dispatch(`hl.dsp.focus({ monitor = ${JSON.stringify(name)} })`);
      return;
    }
    case "focusWindow": {
      const a = addr(body.address);
      if (!a) throw new Error("bad address");
      await dispatch(`hl.dsp.focus({ window = ${JSON.stringify(`address:${a}`)} })`);
      return;
    }
    case "moveWindow": {
      const a = addr(body.address);
      const name = body.monitor;
      if (!a || typeof name !== "string") throw new Error("bad args");
      const monitors = await hyprJson("monitors");
      if (!monitors.some((m) => m.name === name)) throw new Error("bad monitor");
      await dispatch(
        `hl.dsp.window.move({ window = ${JSON.stringify(`address:${a}`)}, monitor = ${JSON.stringify(name)} })`,
      );
      return;
    }
    case "close": {
      const a = addr(body.address);
      if (!a) throw new Error("bad address");
      await dispatch(`hl.dsp.window.close({ window = ${JSON.stringify(`address:${a}`)} })`);
      return;
    }
    case "fullscreen": {
      const a = addr(body.address);
      if (!a) throw new Error("bad address");
      await dispatch(
        `hl.dsp.window.fullscreen({ window = ${JSON.stringify(`address:${a}`)}, mode = "fullscreen" })`,
      );
      return;
    }
    case "float": {
      const a = addr(body.address);
      if (!a) throw new Error("bad address");
      await dispatch(`hl.dsp.window.float({ window = ${JSON.stringify(`address:${a}`)} })`);
      return;
    }
    case "launch": {
      const id = typeof body.id === "string" && APP_ID.test(body.id) ? body.id : null;
      if (!id || !listApps().some((a) => a.id === id)) throw new Error("unknown app");
      // Run through Hyprland's exec so the app inherits the compositor's
      // environment (WAYLAND_DISPLAY etc.), like Omarchy's own launches.
      await dispatch(`hl.dsp.exec_cmd(${luaStr(`gtk-launch ${id}`)})`);
      return;
    }
    case "type": {
      const text = typeof body.text === "string" ? body.text.slice(0, 1000) : null;
      if (text === null) throw new Error("bad text");
      await dispatch(`hl.dsp.exec_cmd(${luaStr(`wtype -- ${shq(text)}`)})`);
      return;
    }
    case "key": {
      // Fixed keysym allow-list; nothing off the wire reaches a shell raw.
      const KEYS = { enter: "Return", tab: "Tab", esc: "Escape", space: "space" };
      const key = KEYS[body.key];
      if (!key) throw new Error("bad key");
      await dispatch(`hl.dsp.exec_cmd(${luaStr(`wtype -k ${key}`)})`);
      return;
    }
    case "media": {
      // MPRIS transport control. Keyboards cannot reach XWayland windows, so
      // media apps are driven over the session bus instead (works without
      // focus). Player and action are validated against a live bus scan.
      const action = MEDIA_METHODS[body.action];
      const player = typeof body.player === "string" ? body.player : null;
      if (!action || !player || !MPRIS_RE.test(player)) throw new Error("bad media args");
      const players = await mprisPlayers();
      if (!players.includes(player)) throw new Error("media player not running");
      await run("busctl", ["--user", "call", player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", action]);
      return;
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

// --- http --------------------------------------------------------------------

const HTML = readFileSync(new URL("./public/index.html", import.meta.url));

function authed(req) {
  const url = new URL(req.url, "http://x");
  return url.searchParams.get("t") === TOKEN || req.headers["x-token"] === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  try {
    if (!authed(req)) return send(401, JSON.stringify({ ok: false, error: "bad token" }));

    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(200, JSON.stringify(await getState()));
    }
    if (req.method === "GET" && url.pathname === "/api/apps") {
      return send(200, JSON.stringify(listApps()));
    }
    if (req.method === "GET" && url.pathname === "/api/media") {
      return send(200, JSON.stringify({ players: await mprisPlayers() }));
    }
    if (req.method === "POST" && url.pathname === "/api/action") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      await doAction(JSON.parse(raw || "{}"));
      return send(200, JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(200, HTML, "text/html");
    }
    return send(404, JSON.stringify({ ok: false, error: "not found" }));
  } catch (e) {
    send(500, JSON.stringify({ ok: false, error: String(e.message ?? e) }));
  }
});

// --- boot --------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address)[0];
  console.log(`omarchy-remote on http://127.0.0.1:${PORT}/?t=${TOKEN}`);
  if (lan) console.log(`phone:      http://${lan}:${PORT}/?t=${TOKEN}`);
  console.log("quit with Ctrl-C");
});
