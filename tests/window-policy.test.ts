import assert from "node:assert/strict";
import test from "node:test";
import { createWindowOptions, installWebContentsGuards } from "../apps/desktop/src/main/window-policy";
import type { WebContents } from "electron";

test("BrowserWindow policy keeps renderer sandboxed", () => {
  const options = createWindowOptions({
    preloadPath: "C:\\approved\\preload.js",
    isDevelopment: true,
    show: false,
  });
  const preferences = options.webPreferences;
  assert.equal(preferences?.sandbox, true);
  assert.equal(preferences?.contextIsolation, true);
  assert.equal(preferences?.nodeIntegration, false);
  assert.equal(preferences?.nodeIntegrationInWorker, false);
  assert.equal(preferences?.nodeIntegrationInSubFrames, false);
  assert.equal(preferences?.webviewTag, false);
  assert.equal(preferences?.webSecurity, true);
  assert.equal(preferences?.allowRunningInsecureContent, false);
  assert.equal(preferences?.devTools, true);
  if (process.platform === 'win32') {
    assert.equal(options.titleBarStyle, 'hidden');
    assert.deepEqual(options.titleBarOverlay, {color:'#f3f5f8',symbolColor:'#555b65',height:32});
  }
});

test("production shell disables renderer DevTools", () => {
  const options = createWindowOptions({
    preloadPath: "C:\\approved\\preload.js",
    isDevelopment: false,
    show: true,
  });
  assert.equal(options.webPreferences?.devTools, false);
});

test("document close key bypasses only the native menu and still reaches the renderer", () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ignored: boolean[] = [];
  const contents = {
    setWindowOpenHandler() {},
    setIgnoreMenuShortcuts(value: boolean) { ignored.push(value); },
    on(name: string, listener: (...args: unknown[]) => void) { listeners.set(name, listener); },
    session: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, on() {} },
  } as unknown as WebContents;
  installWebContentsGuards(contents);
  const handler = listeners.get("before-input-event");
  assert.ok(handler);
  let prevented = 0;
  const event = { preventDefault() { prevented += 1; } };
  for (const input of [
    { control: true, alt: false, shift: false, key: "w" },
    { control: false, alt: false, shift: false, key: "Control" },
    { control: true, alt: false, shift: false, key: "Tab" },
    { control: true, alt: true, shift: false, key: "w" },
    { control: true, alt: false, shift: true, key: "W" },
  ]) handler(event, input);
  assert.deepEqual(ignored, [true, false, false, false, false]);
  assert.equal(prevented, 0, "document handler must still receive the DOM event");
});
