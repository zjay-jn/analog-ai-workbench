import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

const fixtureText = [
  "# Phase 2 只读文档工作台",
  "",
  "这是确定性的合成文本，不来自文件系统。",
  "你可以在这里选择、复制和查找；正文不可编辑。",
  "",
  "- Renderer：sandboxed",
  "- File IPC：关闭",
  "- Provider：read-only fixture",
  "- Client save：deferred",
  "",
].join("\n");

function readStyleNonce(): string {
  const node = document.querySelector('meta[name="aaw-style-nonce"]');
  const nonce = node?.getAttribute("content");
  if (nonce === null || nonce === undefined || nonce.length < 16) {
    throw new Error("The editor CSP nonce is unavailable.");
  }
  return nonce;
}

export function TextEditorFixture(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const state = EditorState.create({
      doc: fixtureText,
      extensions: [
        EditorView.cspNonce.of(readStyleNonce()),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: "0", "aria-label": "只读文档正文" }),
        lineNumbers(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        keymap.of(searchKeymap),
        EditorView.theme({
          "&": {
            height: "100%",
            color: "#253147",
            backgroundColor: "#ffffff",
            fontSize: "13px",
          },
          ".cm-content": {
            padding: "18px 8px 28px",
            fontFamily:
              '"Cascadia Mono", "Segoe UI Mono", Consolas, monospace',
            lineHeight: "1.65",
          },
          ".cm-gutters": {
            color: "#98a2b3",
            backgroundColor: "#f8fafc",
            borderRight: "1px solid #e6eaf0",
          },
          ".cm-activeLine": { backgroundColor: "#f4f7ff" },
          ".cm-activeLineGutter": { backgroundColor: "#edf2ff" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });

    return () => {
      view.destroy();
    };
  }, []);

  return (
    <section className="text-fixture" aria-label="只读文档">
      <div className="editor-host" ref={hostRef} />
    </section>
  );
}
