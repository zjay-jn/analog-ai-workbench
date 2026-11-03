import type {
  BrowserWindowConstructorOptions,
  WebContents,
} from "electron";

export function createWindowOptions(input: {
  readonly preloadPath: string;
  readonly isDevelopment: boolean;
  readonly show: boolean;
}): BrowserWindowConstructorOptions {
  return {
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    show: input.show,
    title: "Analog AI Workbench",
    backgroundColor: "#f3f5f8",
    autoHideMenuBar: true,
    ...(process.platform==='win32'?{titleBarStyle:'hidden' as const,titleBarOverlay:{color:'#f3f5f8',symbolColor:'#555b65',height:32}}:{}),
    webPreferences: {
      preload: input.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      devTools: input.isDevelopment,
      partition: "aaw-phase1",
    },
  };
}

export function installWebContentsGuards(webContents: WebContents): void {
  webContents.on("before-input-event", (_event, input) => {
    // Ctrl+W belongs to the document pane; the native Close Window accelerator
    // must not consume it before the renderer can close its active document.
    webContents.setIgnoreMenuShortcuts(
      input.control && !input.alt && !input.shift && input.key.toLowerCase() === "w",
    );
  });
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event) => event.preventDefault());
  webContents.on("will-attach-webview", (event) => event.preventDefault());

  const guardedSession = webContents.session;
  guardedSession.setPermissionCheckHandler(() => false);
  guardedSession.setPermissionRequestHandler(
    (_requestingWebContents, _permission, callback) => callback(false),
  );
  guardedSession.on("will-download", (event) => event.preventDefault());
}
