import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreDir = existsSync(join(here, "core")) ? join(here, "core") : join(here, "..", "..", "dist");
const load = (name) => import(pathToFileURL(join(coreDir, name)).href);

// Apps started from a launcher do not inherit the shell PATH, so the agent CLIs would not be found.
function fixPath() {
  if (process.platform === "win32") return;
  const extra = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  let shellPath = "";
  try {
    shellPath = execFileSync(process.env.SHELL || "/bin/sh", ["-ilc", 'printf "%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // keep the inherited PATH
  }
  const parts = [...shellPath.split(delimiter), ...(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(delimiter);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

fixPath();

let win = null;
let hub = null;
let web = null;
let quitting = false;

const stateFile = () => join(app.getPath("userData"), "window.json");

function loadBounds() {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return saved.x >= b.x - 50 && saved.y >= b.y - 50 && saved.x < b.x + b.width && saved.y < b.y + b.height;
    });
    return visible ? saved : { width: saved.width, height: saved.height };
  } catch {
    return { width: 1320, height: 860 };
  }
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
  } catch {
    // not critical
  }
}

function send(action) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.webContents.send("menu", action);
  }
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    {
      label: "ファイル",
      submenu: [
        { label: "新しいセッション", accelerator: "CmdOrCtrl+N", click: () => send("new-session") },
        { label: "設定", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit", label: "終了" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "GitHub", click: () => shell.openExternal("https://github.com/etejasdgjjjj532/agent-company") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

async function createWindow() {
  const origin = new URL(web.url).origin;
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    title: "Agent Company",
    show: false,
    backgroundColor: "#161615",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("closed", () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      if (isSafeUrl(url)) shell.openExternal(url);
    }
  });
  await win.loadURL(web.url);
  if (process.env.AGENT_COMPANY_SELFTEST) await selfTest(process.env.AGENT_COMPANY_SELFTEST);
}

// Diagnostic hook for CI and development: load the UI, report the native bridge, save a screenshot, exit.
async function selfTest(shotPath) {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const info = await win.webContents.executeJavaScript(
    "JSON.stringify({ bridge: Object.keys(window.desktop || {}), title: document.title, hasSidebar: !!document.getElementById('sidebar'), text: document.body.innerText.slice(0, 120) })",
  );
  console.log(`SELFTEST ${info}`);
  const parsed = JSON.parse(info);
  const healthy = parsed.hasSidebar && parsed.bridge.includes("pickFolder");
  const image = await win.webContents.capturePage();
  writeFileSync(shotPath, image.toPNG());
  console.log(`SELFTEST screenshot ${shotPath} ${image.getSize().width}x${image.getSize().height}`);
  console.log(healthy ? "SELFTEST OK" : "SELFTEST FAILED");
  app.exit(healthy ? 0 : 1);
}

async function start() {
  const { Hub } = await load("hub.js");
  const { defaultAdapters } = await load("adapters/index.js");
  const { startWebServer } = await load("web/server.js");
  hub = new Hub({ adapters: defaultAdapters(), home: process.env.AGENT_COMPANY_HOME });
  web = await startWebServer({ hub, port: 0 });
  buildMenu();
  await createWindow();
}

ipcMain.handle("dialog:pick-folder", async () => {
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "作業フォルダを選ぶ" });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.on("notify", (_event, { title, body }) => {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body });
  note.on("click", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  note.show();
});

ipcMain.on("open-external", (_event, url) => {
  if (isSafeUrl(url)) shell.openExternal(url);
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("activate", () => {
  if (!win && web) createWindow().catch((error) => dialog.showErrorBox("Agent Company", String(error?.message ?? error)));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  try {
    await hub?.stop();
    await web?.close();
  } finally {
    app.exit(0);
  }
});

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox("Agent Company を起動できません", String(error?.stack ?? error));
  app.exit(1);
});
