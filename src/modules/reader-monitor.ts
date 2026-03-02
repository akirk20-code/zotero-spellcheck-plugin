/**
 * Reader Monitor (Event-Driven)
 *
 * Detects PDF reader instances and finds editable annotation comment fields
 * using Zotero's Reader event API + MutationObserver. No polling required.
 *
 * Detection strategy:
 * 1. renderToolbar event → fires for ALL readers (even without annotations)
 * 2. renderSidebarAnnotationHeader event → fires when annotation cards render
 * 3. MutationObserver on each reader's iframe document → catches dynamic
 *    textarea/contenteditable creation when user clicks to edit a comment
 */

import { config } from "../../package.json";
import { logToFile } from "../utils/log";

export class ReaderMonitor {
  private static attachedDocuments = new WeakSet<Document>();
  private static attachedElements = new WeakSet<Element>();
  private static callback:
    | ((element: HTMLElement, iframeWindow: Window) => void)
    | null = null;
  private static documentCallback:
    | ((doc: Document, iframeWindow: Window) => void)
    | null = null;
  private static observers: MutationObserver[] = [];
  private static scanTimers = new Map<Document, ReturnType<typeof setTimeout>>();
  private static mutationCount = 0;

  // Store handler references for cleanup
  private static toolbarHandler:
    | ((event: any) => void | Promise<void>)
    | null = null;
  private static sidebarHandler:
    | ((event: any) => void | Promise<void>)
    | null = null;

  /**
   * Start monitoring for PDF reader comment fields.
   * Uses Zotero.Reader event API for zero-polling detection.
   *
   * @param onEditableFound Called when a textarea/contenteditable is discovered
   * @param onDocumentReady Called when a reader document is first attached (for document-level listeners)
   */
  static start(
    onEditableFound: (element: HTMLElement, iframeWindow: Window) => void,
    onDocumentReady?: (doc: Document, iframeWindow: Window) => void,
  ): void {
    this.callback = onEditableFound;
    this.documentCallback = onDocumentReady || null;
    logToFile("[ReaderMonitor] start() called");

    // renderToolbar fires for ALL readers (even without annotations).
    // This is our primary reader detection mechanism.
    this.toolbarHandler = (event: any) => {
      const reader = event.reader as _ZoteroTypes.ReaderInstance;
      logToFile("[ReaderMonitor] renderToolbar event fired");
      this.attachToReaderDocument(reader);
    };
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      this.toolbarHandler as any,
      config.addonID,
    );

    // renderSidebarAnnotationHeader fires when annotation cards render.
    // Additional signal that annotations are visible in the sidebar.
    this.sidebarHandler = (event: any) => {
      const reader = event.reader as _ZoteroTypes.ReaderInstance;
      logToFile("[ReaderMonitor] renderSidebarAnnotationHeader event fired");
      this.attachToReaderDocument(reader);
    };
    Zotero.Reader.registerEventListener(
      "renderSidebarAnnotationHeader",
      this.sidebarHandler as any,
      config.addonID,
    );

    // Check already-open readers immediately
    this.checkExistingReaders();

    logToFile("[ReaderMonitor] Started (event-driven, zero polling)");
  }

  /**
   * Check already-open readers on startup.
   */
  private static async checkExistingReaders(): Promise<void> {
    const readers = Zotero.Reader._readers;
    logToFile(
      "[ReaderMonitor] Checking " + readers.length + " existing readers",
    );
    for (const reader of readers) {
      await this.attachToReaderDocument(reader);
    }
  }

  /**
   * Attach MutationObserver to a reader's iframe document.
   * Idempotent — safe to call multiple times for the same reader.
   */
  private static async attachToReaderDocument(
    reader: _ZoteroTypes.ReaderInstance,
  ): Promise<void> {
    // Wait for reader init if needed
    try {
      await reader._initPromise;
    } catch (e) {
      logToFile("[ReaderMonitor] _initPromise failed: " + e);
      return;
    }

    const iframeWin = reader._iframeWindow;
    if (!iframeWin) {
      logToFile("[ReaderMonitor] No _iframeWindow on reader");
      return;
    }

    const doc = iframeWin.document;

    // Only attach once per document
    if (this.attachedDocuments.has(doc)) return;
    this.attachedDocuments.add(doc);

    logToFile(
      "[ReaderMonitor] Attaching to reader document: " +
        (doc.location?.href || "unknown"),
    );

    // Log DOM structure for first-run diagnostics
    this.logDomStructure(doc);

    // Scan for existing editables
    this.scanForEditables(doc, iframeWin);

    // Watch for dynamically created elements (React re-renders).
    // The comment textarea only appears when the user clicks to edit
    // an annotation, so we need to catch its creation.
    try {
      this.observeDocument(doc, iframeWin, "main");
    } catch (e) {
      logToFile("[ReaderMonitor] Error setting up main observer: " + e);
    }

    // Also monitor nested iframes (PDF viewer may contain editable fields)
    try {
      const iframes = doc.querySelectorAll("iframe");
      logToFile("[ReaderMonitor] Scanning " + iframes.length + " nested iframes");
      for (let i = 0; i < iframes.length; i++) {
        try {
          const nestedFrame = iframes[i] as HTMLIFrameElement;
          const nestedDoc =
            nestedFrame.contentDocument ||
            nestedFrame.contentWindow?.document;
          const nestedWin = nestedFrame.contentWindow;
          if (nestedDoc && nestedWin) {
            logToFile(
              "[ReaderMonitor] Nested iframe[" +
                i +
                "]: " +
                (nestedDoc.location?.href || "unknown"),
            );
            this.logDomStructure(nestedDoc);
            this.scanForEditables(nestedDoc, nestedWin);
            this.observeDocument(nestedDoc, nestedWin, "iframe[" + i + "]");
          } else {
            logToFile(
              "[ReaderMonitor] Nested iframe[" + i + "]: no doc/win access",
            );
          }
        } catch (e) {
          logToFile(
            "[ReaderMonitor] Cannot access nested iframe[" +
              i +
              "]: " +
              e,
          );
        }
      }
    } catch (e) {
      logToFile("[ReaderMonitor] Error scanning nested iframes: " + e);
    }
  }

  /**
   * Set up a MutationObserver on a document to detect editable elements.
   * Also notifies the document callback so document-level listeners can be set up.
   */
  private static observeDocument(
    doc: Document,
    win: Window,
    label: string,
  ): void {
    const body = doc.body || doc.documentElement;
    if (!body) return;

    // Notify document callback for document-level listener setup
    this.documentCallback?.(doc, win);

    // MutationObserver is not available in plugin sandbox — get from window context
    const MO = (win as any).MutationObserver;
    if (!MO) {
      logToFile("[ReaderMonitor] MutationObserver not available on " + label);
      return;
    }

    const observer = new MO(() => {
      this.mutationCount++;
      // Log first few mutations for diagnostics
      if (
        this.mutationCount === 1 ||
        this.mutationCount === 5 ||
        this.mutationCount === 20
      ) {
        logToFile(
          "[ReaderMonitor] Mutation #" +
            this.mutationCount +
            " in " +
            label,
        );
      }
      this.debouncedScan(doc, win);
    });
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["contenteditable"],
    });
    this.observers.push(observer);
    logToFile(
      "[ReaderMonitor] MutationObserver attached to " + label,
    );
  }

  /**
   * Debounced scan — waits 100ms after the last mutation before scanning.
   * Prevents excessive scanning during React batch updates.
   */
  private static debouncedScan(doc: Document, win: Window): void {
    const existing = this.scanTimers.get(doc);
    if (existing) clearTimeout(existing);

    this.scanTimers.set(
      doc,
      setTimeout(() => {
        this.scanTimers.delete(doc);
        this.scanForEditables(doc, win);
      }, 100),
    );
  }

  /**
   * Scan a document for textarea and contenteditable elements.
   * Only calls back for newly discovered elements (tracked via WeakSet).
   */
  private static scanForEditables(doc: Document, win: Window): void {
    const editables = doc.querySelectorAll(
      'textarea, [contenteditable="true"], [contenteditable=""]',
    );
    for (const el of editables) {
      if (!this.attachedElements.has(el)) {
        this.attachedElements.add(el);
        const tag = el.tagName;
        const cls = el.className
          ? "." + String(el.className).split(" ")[0]
          : "";
        const parent = el.parentElement;
        const parentInfo = parent
          ? parent.tagName +
            (parent.className
              ? "." + String(parent.className).split(" ")[0]
              : "")
          : "none";
        logToFile(
          "[ReaderMonitor] Found editable: " +
            tag +
            cls +
            " (parent: " +
            parentInfo +
            ")",
        );
        this.callback?.(el as HTMLElement, win);
      }
    }
  }

  /**
   * Log DOM structure for debugging (first-run diagnostics).
   */
  private static logDomStructure(doc: Document): void {
    try {
      const body = doc.body;
      if (!body) {
        logToFile("[ReaderMonitor] No body element");
        return;
      }
      const children = Array.from(body.children).slice(0, 15);
      const tags = children.map(
        (el) =>
          el.tagName +
          (el.id ? "#" + el.id : "") +
          (el.className
            ? "." +
              String(el.className).split(" ").slice(0, 2).join(".")
            : ""),
      );
      logToFile("[ReaderMonitor] Body children: " + tags.join(", "));

      // Look for iframes inside
      const iframes = doc.querySelectorAll("iframe");
      logToFile("[ReaderMonitor] Nested iframes: " + iframes.length);

      // Look for sidebar-related elements
      const sidebar =
        doc.querySelector('[class*="sidebar"]') ||
        doc.querySelector("[data-sidebar]") ||
        doc.querySelector(".sidebar");
      logToFile(
        "[ReaderMonitor] Sidebar element: " +
          (sidebar
            ? sidebar.tagName + "." + sidebar.className
            : "not found by class"),
      );

      // Count existing textareas and contenteditable elements
      const textareas = doc.querySelectorAll("textarea");
      const contentEditables = doc.querySelectorAll(
        '[contenteditable="true"]',
      );
      logToFile(
        "[ReaderMonitor] Existing textareas: " +
          textareas.length +
          ", contentEditables: " +
          contentEditables.length,
      );
    } catch (e) {
      logToFile("[ReaderMonitor] Error logging DOM: " + e);
    }
  }

  /**
   * Stop monitoring and clean up all resources.
   */
  static stop(): void {
    if (this.toolbarHandler) {
      try {
        Zotero.Reader.unregisterEventListener(
          "renderToolbar",
          this.toolbarHandler as any,
        );
      } catch {
        /* may already be cleaned up */
      }
      this.toolbarHandler = null;
    }
    if (this.sidebarHandler) {
      try {
        Zotero.Reader.unregisterEventListener(
          "renderSidebarAnnotationHeader",
          this.sidebarHandler as any,
        );
      } catch {
        /* may already be cleaned up */
      }
      this.sidebarHandler = null;
    }
    for (const observer of this.observers) {
      observer.disconnect();
    }
    this.observers = [];
    for (const timer of this.scanTimers.values()) {
      clearTimeout(timer);
    }
    this.scanTimers.clear();
    this.callback = null;
    this.documentCallback = null;
    logToFile("[ReaderMonitor] Stopped");
  }
}
