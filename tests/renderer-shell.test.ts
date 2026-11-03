import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("apps/desktop/src/renderer/App.tsx", "utf8");
const entry = readFileSync("apps/desktop/src/renderer/main.tsx", "utf8");
const html = readFileSync("apps/desktop/index.html", "utf8");
const styles = readFileSync("apps/desktop/src/renderer/styles.css", "utf8");
const textFixture = readFileSync(
  "apps/desktop/src/renderer/documents/text/TextEditorFixture.tsx",
  "utf8",
);
const documentPathBreadcrumb = readFileSync(
  "apps/desktop/src/renderer/documents/DocumentPathBreadcrumb.tsx",
  "utf8",
);
const schematicWorkspace = readFileSync(
  "apps/desktop/src/renderer/schematic/SchematicWorkspace.tsx",
  "utf8",
);
const schematicViewer = readFileSync(
  "apps/desktop/src/renderer/SchematicViewer.tsx",
  "utf8",
);

test("renderer stylesheet loads as a CSP-compatible external resource", () => {
  assert.match(
    html,
    /<link\s+rel="stylesheet"\s+href="\/src\/renderer\/styles\.css"\s*\/>/u,
  );
  assert.doesNotMatch(entry, /import\s+["'].\/styles\.css["']/u);
});

test("workspace begins below the native title bar and keeps an accessible runtime status", () => {
  assert.doesNotMatch(app, /className="topbar"|className="brand-mark"|className="status-dot"/u);
  assert.doesNotMatch(styles, /\.topbar\s*\{|\.brand-mark\s*\{|\.status-dot\s*\{/u);
  assert.match(app, /className="runtime-status"[\s\S]*?data-testid="runtime-status"/u);
  assert.match(app, /aria-live="polite"[\s\S]*?role="status"/u);
  assert.match(styles, /\.runtime-status\s*\{[\s\S]*?clip-path:\s*inset\(50%\)/u);
  assert.match(styles, /\.workspace-grid\s*\{[\s\S]*?height:\s*100vh/u);
  assert.match(app, /桌面内核已连接/u);
  assert.match(app, /开发运行/u);
  assert.match(app, /本地构建/u);
  assert.doesNotMatch(app, /主进程已连接 · \$\{runtime\.info\.mode\}/u);
});

test("file-backed creation remains visibly deferred without adding file capability", () => {
  assert.match(app, /aria-label="新建任务（尚未开放）"[\s\S]*?disabled/u);
  assert.match(
    app,
    /aria-label="新建文件标签（客户端文件能力延期）"[\s\S]*?disabled/u,
  );
  assert.doesNotMatch(textFixture, /openSearchPanel|客户端保存（已延期）|保存延期/u);
  assert.match(styles, /cursor:\s*not-allowed/u);
});

test("conversation column contains no Phase status card or outer scrolling region", () => {
  assert.doesNotMatch(app, /activity-card|Phase 3 只读接线离散验收状态|progress-track/u);
  assert.match(styles, /\.conversation-pane\s*\{[\s\S]*?overflow:\s*hidden/u);
  assert.match(styles, /\.agent-panel\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0/u);
  assert.match(styles, /\.agent-transcript\s*\{[\s\S]*?overflow:\s*auto/u);
});

test("task rail presents title-only navigation without numbered badges or status subtitles", () => {
  assert.match(app, /"软件产品主控"/u);
  assert.match(app, /"桌面架构与安全"/u);
  assert.match(app, /"文档与文本工作区"/u);
  assert.match(app, /"测试、验收与发布"/u);
  assert.doesNotMatch(app, /task-icon/u);
  assert.doesNotMatch(app, /Phase 2 · active|contract frozen|save deferred|read-only evidence/u);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*?\.task-rail \{ display: none; \}/u);
});

test("document pane mounts the synthetic read-only CodeMirror fixture without file claims", () => {
  assert.match(app, /<TextEditorFixture \/>/u);
  assert.doesNotMatch(app, /Provider: synthetic read-only fixture/u);
  assert.doesNotMatch(app, /document-footer|Provider: synthetic reviewed registry|File IPC: OFF/u);
  assert.doesNotMatch(app, /Provider: text file/u);
  assert.match(textFixture, /EditorState\.readOnly\.of\(true\)/u);
  assert.match(textFixture, /EditorView\.editable\.of\(false\)/u);
  assert.match(app, /<DocumentPathBreadcrumb[\s\S]*?activeDocumentTab=\{activeDocumentTab\}[\s\S]*?onSelectDocument=\{\(tab\) => reopenDocumentTab\(tab, false\)\}/u);
  assert.match(documentPathBreadcrumb, /name: "fixture-notes\.txt"/u);
  assert.doesNotMatch(textFixture, /fixture-file-path|路径：|fixture-notes\.txt/u);
  assert.doesNotMatch(textFixture, /[A-Za-z]:\\|file:\/\//u);
  assert.doesNotMatch(textFixture, /CONTENT_CHANGED/u);
});

test("schematic tab shows one relative path then the interactive content", () => {
  assert.match(app, />\s*flat-basic\.schematic\s*<\/button>/u);
  assert.match(documentPathBreadcrumb, /name: "flat-basic\.schematic"/u);
  assert.doesNotMatch(schematicWorkspace, /schematic-file-path|路径：内置示例\\flat-basic\.schematic/u);
  assert.doesNotMatch(schematicWorkspace, /<strong[^>]*>flat-basic\.schematic|Provider:|File IPC:/u);
  assert.doesNotMatch(schematicViewer, /schematic-viewer-header|Synthetic reviewed schematic<\/h2>/u);
  assert.match(schematicViewer, /className="schematic-viewer-a11y-status"/u);
  assert.match(schematicViewer, />\s*适合窗口\s*<\/button>/u);
  assert.match(schematicViewer, />\s*检查器\s*<\/button>/u);
  assert.match(schematicViewer, /aria-label="原理图层次"/u);
});

test("text fixture exposes only file identity and read-only body chrome", () => {
  assert.doesNotMatch(textFixture, /text-fixture-header|<strong>fixture-notes\.txt<\/strong>/u);
  assert.match(app, />\s*fixture-notes\.txt\s*<\/button>/u);
  assert.match(styles, /\.text-fixture\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;[\s\S]*?height:\s*100%/u);
  assert.match(styles, /\.editor-host\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/u);
  assert.match(styles, /\.editor-host \.cm-editor,[\s\S]*?\.editor-host \.cm-scroller\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/u);
  assert.doesNotMatch(
    textFixture,
    /editor-actions|fixture-safety-note|proposal-review|readonly-divider|SYNTHETIC AGENT PROPOSAL|同意提案|拒绝提案/u,
  );
  assert.doesNotMatch(textFixture, /window\.workbench/u);
});

test("shared document path control exposes a keyboard-operable document list without a fabricated root", () => {
  assert.match(documentPathBreadcrumb, /aria-haspopup="tree"/u);
  assert.match(documentPathBreadcrumb, /aria-expanded=\{open\}/u);
  assert.match(documentPathBreadcrumb, /role="tree"/u);
  assert.match(documentPathBreadcrumb, /aria-label="可用的只读文档"/u);
  assert.doesNotMatch(documentPathBreadcrumb, /内置示例|document-path-separator|role="group"/u);
  assert.match(documentPathBreadcrumb, /aria-current=\{document\.id === activeDocumentTab \? "page" : undefined\}/u);
  assert.match(documentPathBreadcrumb, /aria-selected=\{document\.id === activeDocumentTab\}/u);
  assert.match(documentPathBreadcrumb, /event\.key === "Escape"[\s\S]*?closeAndRestoreFocus\(\)/u);
  assert.match(documentPathBreadcrumb, /event\.key === "ArrowDown"[\s\S]*?event\.key === "ArrowUp"[\s\S]*?event\.key === "Home"[\s\S]*?event\.key === "End"/u);
  assert.match(documentPathBreadcrumb, /triggerRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.doesNotMatch(documentPathBreadcrumb, /window\.workbench|fetch\(|XMLHttpRequest|node:fs|electron/u);
  assert.doesNotMatch(documentPathBreadcrumb, /[A-Za-z]:\\|file:\/\//u);
});

test("synthetic identity and lifecycle remain visible without restoring extra headers", () => {
  for (const selector of ["agent-safety-label", "agent-lifecycle"]) {
    const declaration = styles.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`, "u"))?.[1];
    assert.ok(declaration, selector);
    assert.doesNotMatch(declaration, /clip:|clip-path:|position:\s*absolute|(?:width|height):\s*1px|display:\s*none/u);
    assert.match(declaration, /font-size:\s*(?:9|10)px/u);
  }
  assert.match(schematicViewer, /className="schematic-viewer-identity"[\s\S]*?\{PERSISTENT_BANNER\}/u);
  assert.match(schematicViewer, /scene\.historicalWarningVisible === true[\s\S]*?className="schematic-historical-warning"/u);
  assert.doesNotMatch(schematicViewer, /schematic-viewer-header|Synthetic reviewed schematic<\/h2>/u);
});

test("read-only editor keeps keyboard focus and composer follows the requested neutral focus styling", () => {
  assert.match(textFixture, /EditorState\.readOnly\.of\(true\)/u);
  assert.match(textFixture, /EditorView\.editable\.of\(false\)/u);
  assert.match(textFixture, /EditorView\.contentAttributes\.of\(\{\s*tabindex:\s*"0"/u);
  assert.match(textFixture, /keymap\.of\(searchKeymap\)/u);
  assert.match(styles, /\.editor-host \.cm-content:focus-visible\s*\{[^}]*outline:\s*2px solid/u);
  assert.match(styles, /\.agent-composer textarea:focus-visible\s*\{[^}]*outline:\s*none/u);
  assert.match(styles, /\.agent-composer\s*\{[^}]*margin-top:\s*auto/u);
  assert.match(styles, /@media \(forced-colors: active\)\s*\{\s*\.agent-composer textarea:focus-visible,[\s\S]*?outline:\s*3px solid Highlight/u);
});

test("empty reviewed Inspector can open without a fabricated target and modal cleanup restores focus", () => {
  assert.match(schematicViewer, /\[emptyInspectorOpen, setEmptyInspectorOpen\] = useState\(false\)/u);
  assert.match(schematicViewer, /if \(inspectorOpenTarget !== undefined\)[\s\S]*?type: "open-inspector"[\s\S]*?else \{\s*setEmptyInspectorOpen\(true\)/u);
  assert.doesNotMatch(schematicViewer, /disabled=\{viewState\.inspector === null && inspectorOpenTarget === undefined\}/u);
  assert.match(schematicViewer, /event\.key === "Tab" && inspectorLayoutMode === "modal"/u);
  assert.match(schematicViewer, /if \(!wasInert\) node\.removeAttribute\("inert"\)/u);
  assert.match(schematicViewer, /document\.removeEventListener\("focusin", keepFocusInside\)/u);
  assert.match(schematicViewer, /inspectorToggleRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
});
