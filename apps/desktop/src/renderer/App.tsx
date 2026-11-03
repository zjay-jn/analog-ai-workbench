import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AppInfoV1 } from "../shared/app-info";
import type { ResolveReviewedArtifactRequestV1 } from "../shared/schematic/reviewed-artifact-resolve";
import { AgentPanel } from "./agent/AgentPanel";
import {CloudAgentPanel} from './agent/CloudAgentPanel';
import {SessionWorkspace} from './agent/SessionWorkspace';
import {EnginePilotPanel} from './agent/EnginePilotPanel';
import {WindowTitleBar} from './WindowTitleBar';
import { DocumentPathBreadcrumb } from "./documents/DocumentPathBreadcrumb";
import { TextEditorFixture } from "./documents/text/TextEditorFixture";
import { SchematicWorkspace } from "./schematic/SchematicWorkspace";

type RuntimeState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly info: AppInfoV1 }
  | { readonly kind: "error"; readonly message: string };

const tasks = [
  "软件产品主控",
  "桌面架构与安全",
  "文档与文本工作区",
  "测试、验收与发布",
] as const;

function runtimeModeLabel(mode: AppInfoV1["mode"]): string {
  if (mode === "development") return "开发运行";
  if (mode === "production") return "本地构建";
  return "验收运行";
}

export type AppPropsV1 = Readonly<{
  schematicRequest?: ResolveReviewedArtifactRequestV1;
}>;

export function App({ schematicRequest }: AppPropsV1 = {}): React.JSX.Element {
  const cloudApi=typeof window==='undefined'?undefined:window.workbenchCloud;
  const enginePilotApi=typeof window==='undefined'?undefined:window.workbenchEnginePilot;
  const sessionsApi=typeof window==='undefined'?undefined:window.workbenchSessions;
  const standalonePilot=!!enginePilotApi&&!sessionsApi;
  const windowMenuApi=typeof window==='undefined'?undefined:window.workbenchWindowMenu;
  const [runtime, setRuntime] = useState<RuntimeState>({ kind: "loading" });
  const [openDocumentTabs, setOpenDocumentTabs] = useState<Array<"text" | "schematic">>(["text", "schematic"]);
  const [activeDocumentTab, setActiveDocumentTab] = useState<
    "text" | "schematic" | null
  >("schematic");
  const documentTabRefs = useRef<
    Record<"text" | "schematic", HTMLButtonElement | null>
  >({ text: null, schematic: null });
  const emptyDocumentRef = useRef<HTMLDivElement | null>(null);
  const pendingDocumentFocus = useRef<"text" | "schematic" | "empty" | null>(null);

  useEffect(() => {
    const target = pendingDocumentFocus.current;
    pendingDocumentFocus.current = null;
    if (target === "empty") emptyDocumentRef.current?.focus();
    else if (target !== null) documentTabRefs.current[target]?.focus();
  }, [activeDocumentTab, openDocumentTabs]);

  const activateDocumentTab = (tab: "text" | "schematic"): void => {
    setActiveDocumentTab(tab);
    documentTabRefs.current[tab]?.focus();
  };

  const reopenDocumentTab = (tab: "text" | "schematic", focus = true): void => {
    if (focus) pendingDocumentFocus.current = tab;
    setOpenDocumentTabs((current) => current.includes(tab)
      ? [...current]
      : (["text", "schematic"] as const).filter((item) => item === tab || current.includes(item)));
    setActiveDocumentTab(tab);
  };

  const closeDocumentTab = (tab: "text" | "schematic"): void => {
    const remaining = openDocumentTabs.filter((item) => item !== tab);
    const next = activeDocumentTab === tab
      ? (remaining[Math.min(openDocumentTabs.indexOf(tab), remaining.length - 1)] ?? null)
      : activeDocumentTab;
    pendingDocumentFocus.current = next ?? "empty";
    setOpenDocumentTabs(remaining);
    setActiveDocumentTab(next);
  };

  const handleDocumentShortcut = (event: KeyboardEvent<HTMLElement>): void => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key !== "Tab" && event.key.toLowerCase() !== "w") return;
    if (event.key.toLowerCase() === "w" && event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (activeDocumentTab === null) return;
    if (event.key.toLowerCase() === "w") {
      closeDocumentTab(activeDocumentTab);
      return;
    }
    // Cycling cannot escape a modal; closing its owning document still works.
    if ((event.target as HTMLElement).closest('[aria-modal="true"]')) return;
    const index = openDocumentTabs.indexOf(activeDocumentTab);
    const next = openDocumentTabs[(index + (event.shiftKey ? -1 : 1) + openDocumentTabs.length) % openDocumentTabs.length];
    if (next !== undefined) activateDocumentTab(next);
  };

  const handleDocumentTabsKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    const order = openDocumentTabs;
    const currentIndex = order.findIndex((tab) => documentTabRefs.current[tab] === event.target);
    if (currentIndex < 0) return;
    const move = (delta: number): void => {
      const next = order[(currentIndex + delta + order.length) % order.length];
      if (next !== undefined) activateDocumentTab(next);
    };
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const first = order[0];
      if (first !== undefined) activateDocumentTab(first);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const last = order[order.length - 1];
      if (last !== undefined) activateDocumentTab(last);
    }
  };

  useEffect(() => {
    if (standalonePilot) return;
    let active = true;
    window.workbench
      .getInfo()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setRuntime({ kind: "ready", info: result.value });
        } else {
          setRuntime({ kind: "error", message: result.error.message });
        }
      })
      .catch(() => {
        if (active) {
          setRuntime({ kind: "error", message: "主进程连接失败。" });
        }
      });
    return () => {
      active = false;
    };
  }, [standalonePilot]);

  const statusText =
    runtime.kind === "loading"
      ? "正在验证本地安全链路…"
      : runtime.kind === "ready"
        ? `桌面内核已连接 · ${runtimeModeLabel(runtime.info.mode)}`
        : runtime.message;

  return (
    <div className={`app-shell${windowMenuApi ? ' app-shell-with-titlebar' : ''}`}>
      {windowMenuApi && <WindowTitleBar api={windowMenuApi}/>}
      {!standalonePilot && <span
        aria-atomic="true"
        aria-live="polite"
        className="runtime-status"
        data-testid="runtime-status"
        data-state={runtime.kind}
        role="status"
      >
        {statusText}
      </span>}

      <div className="workspace-grid">
        {sessionsApi ? <SessionWorkspace api={sessionsApi}/> : enginePilotApi ? <EnginePilotPanel api={enginePilotApi}/> : <>
        <aside className="task-rail" aria-label="任务与会话">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">WORKSPACE</p>
              <h2>任务与会话</h2>
            </div>
            <button
              aria-label="新建任务（尚未开放）"
              className="icon-button"
              type="button"
              disabled
              title="后续阶段开放"
            >
              ＋
            </button>
          </div>
          <nav className="task-list">
            {tasks.map((task, index) => (
              <button
                className={`task-card${index === 0 ? " task-card-active" : ""}`}
                key={task}
                type="button"
                aria-current={index === 0 ? "page" : undefined}
                disabled
                title="Phase 1 阶段概览（只读）"
              >
                <strong>{task}</strong>
              </button>
            ))}
          </nav>
          <div className="rail-note">
            <span>本地优先</span>
            <p>{cloudApi ? '已启用云端文本对话。任务列表为只读示例。' : '当前未连接模型、RAG、EDA 或云服务。'}</p>
          </div>
        </aside>

        <main className="conversation-pane">
          {runtime.kind === "ready" ? (
            cloudApi ? <CloudAgentPanel api={cloudApi} /> : <AgentPanel conversationTitle={tasks[0]} mode={runtime.info.mode} />
          ) : (
            <section className="agent-panel" aria-labelledby="agent-panel-title">
              <div className="agent-panel-heading">
                <h1 id="agent-panel-title">软件产品主控</h1>
                <span className="agent-safety-label">SYNTHETIC AGENT · NO MODEL · NO TOOLS</span>
              </div>
              <div className="agent-unavailable" role="status">
                <strong>{runtime.kind === "loading" ? "Checking local Agent boundary…" : "Synthetic Agent is unavailable."}</strong>
                <p>{runtime.kind === "error" ? runtime.message : "No model, RAG, tool or network is being contacted."}</p>
              </div>
            </section>
          )}
        </main>

        </>}

        {!enginePilotApi&&!sessionsApi&&<aside className="document-pane" aria-label="统一文档工作区" onKeyDownCapture={handleDocumentShortcut}>
          <div
            className="document-tabs"
            role="tablist"
            aria-label="文档标签"
            onKeyDown={handleDocumentTabsKeyDown}
          >
            {openDocumentTabs.includes("text") ? <div className="document-tab-item" role="presentation">
            <button
              aria-controls="document-panel-text"
              aria-selected={activeDocumentTab === "text"}
              className={`document-tab${
                activeDocumentTab === "text" ? " document-tab-active" : ""
              }`}
              id="document-tab-text"
              onClick={() => setActiveDocumentTab("text")}
              ref={(node) => {
                documentTabRefs.current.text = node;
              }}
              role="tab"
              tabIndex={activeDocumentTab === "text" ? 0 : -1}
              type="button"
            >
              fixture-notes.txt
            </button>
            <button type="button" className="document-tab-close" aria-label="关闭 fixture-notes.txt" tabIndex={-1} onClick={() => closeDocumentTab("text")}>×</button>
            </div> : null}
            {openDocumentTabs.includes("schematic") ? <div className="document-tab-item" role="presentation">
            <button
              aria-controls="document-panel-schematic"
              aria-selected={activeDocumentTab === "schematic"}
              className={`document-tab${
                activeDocumentTab === "schematic" ? " document-tab-active" : ""
              }`}
              id="document-tab-schematic"
              onClick={() => setActiveDocumentTab("schematic")}
              ref={(node) => {
                documentTabRefs.current.schematic = node;
              }}
              role="tab"
              tabIndex={activeDocumentTab === "schematic" ? 0 : -1}
              type="button"
            >
              flat-basic.schematic
            </button>
            <button type="button" className="document-tab-close" aria-label="关闭 flat-basic.schematic" tabIndex={-1} onClick={() => closeDocumentTab("schematic")}>×</button>
            </div> : null}
            <button
              aria-label="新建文件标签（客户端文件能力延期）"
              className="document-tab"
              type="button"
              disabled
              title="本地文件打开与保存尚未开放"
            >
              ＋
            </button>
          </div>
          {activeDocumentTab !== null ? <DocumentPathBreadcrumb
            activeDocumentTab={activeDocumentTab}
            onSelectDocument={(tab) => reopenDocumentTab(tab, false)}
          /> : null}
          <div className="document-canvas editor-canvas">
            {activeDocumentTab === null ? <div className="document-empty-state" ref={emptyDocumentRef} tabIndex={-1} role="region" aria-label="文档空状态">
              <p>没有打开的文档</p>
              <p>SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED</p>
              <button type="button" onClick={() => reopenDocumentTab("text")}>重新打开 fixture-notes.txt</button>
              <button type="button" onClick={() => reopenDocumentTab("schematic")}>重新打开 flat-basic.schematic</button>
            </div> : null}
            {openDocumentTabs.includes("text") ?
            <div
              aria-labelledby="document-tab-text"
              className="document-tab-panel"
              hidden={activeDocumentTab !== "text"}
              id="document-panel-text"
              role="tabpanel"
            >
              <TextEditorFixture />
            </div> : null}
            {openDocumentTabs.includes("schematic") ?
            <div
              aria-labelledby="document-tab-schematic"
              className="document-tab-panel"
              hidden={activeDocumentTab !== "schematic"}
              id="document-panel-schematic"
              role="tabpanel"
            >
              {schematicRequest === undefined ? (
                <SchematicWorkspace />
              ) : (
                <SchematicWorkspace request={schematicRequest} />
              )}
            </div> : null}
          </div>
        </aside>}
      </div>
    </div>
  );
}
