import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export type DocumentTabIdV1 = "text" | "schematic";

const DOCUMENTS = Object.freeze([
  Object.freeze({ id: "text" as const, name: "fixture-notes.txt" }),
  Object.freeze({ id: "schematic" as const, name: "flat-basic.schematic" }),
]);

export type DocumentPathBreadcrumbPropsV1 = Readonly<{
  activeDocumentTab: DocumentTabIdV1;
  onSelectDocument: (tab: DocumentTabIdV1) => void;
}>;

export function DocumentPathBreadcrumb({
  activeDocumentTab,
  onSelectDocument,
}: DocumentPathBreadcrumbPropsV1): React.JSX.Element {
  const treeId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = DOCUMENTS.findIndex(({ id }) => id === activeDocumentTab);
  const activeDocument = DOCUMENTS[activeIndex] ?? DOCUMENTS[0]!;

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus({ preventScroll: true });
  }, [activeIndex, open]);

  useEffect(() => {
    setOpen(false);
  }, [activeDocumentTab]);

  const closeAndRestoreFocus = (): void => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const selectDocument = (tab: DocumentTabIdV1): void => {
    onSelectDocument(tab);
    closeAndRestoreFocus();
  };

  const handleTreeKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    const focusedIndex = itemRefs.current.findIndex(
      (node) => node === event.target,
    );
    if (focusedIndex < 0) return;
    const nextIndex =
      event.key === "ArrowDown"
        ? (focusedIndex + 1) % DOCUMENTS.length
        : event.key === "ArrowUp"
          ? (focusedIndex - 1 + DOCUMENTS.length) % DOCUMENTS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? DOCUMENTS.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    itemRefs.current[nextIndex]?.focus({ preventScroll: true });
  };

  return (
    <nav aria-label="文档路径" className="document-pathbar">
      <button
        aria-controls={treeId}
        aria-expanded={open}
        aria-haspopup="tree"
        className="document-path-trigger"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
            event.preventDefault();
            setOpen(true);
          }
          if (open && event.key === "Escape") {
            event.preventDefault();
            closeAndRestoreFocus();
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="document-path-current">{activeDocument.name}</span>
        <span aria-hidden="true" className="document-path-chevron">⌄</span>
      </button>
      {open ? (
        <div
          aria-label="可用的只读文档"
          className="document-path-tree"
          id={treeId}
          onKeyDown={handleTreeKeyDown}
          role="tree"
        >
          {DOCUMENTS.map((document, index) => (
            <button
              aria-current={document.id === activeDocumentTab ? "page" : undefined}
              aria-selected={document.id === activeDocumentTab}
              className="document-tree-item"
              key={document.id}
              onClick={() => selectDocument(document.id)}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              role="treeitem"
              tabIndex={document.id === activeDocumentTab ? 0 : -1}
              type="button"
            >
              {document.name}
            </button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
