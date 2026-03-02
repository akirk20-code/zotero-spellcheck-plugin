/**
 * Editor Monitor
 *
 * Detects note editors via monkey-patch on Zotero.Notes.registerEditorInstance.
 * Also checks already-open editors on startup. No polling required.
 */

import { logToFile } from "../utils/log";

export class EditorMonitor {
  private static originalRegister: Function | null = null;
  private static attachedEditors = new WeakSet<Zotero.EditorInstance>();
  private static callback:
    | ((editor: Zotero.EditorInstance) => void)
    | null = null;

  /**
   * Start monitoring for note editor instances.
   */
  static start(onEditorReady: (editor: Zotero.EditorInstance) => void): void {
    this.callback = onEditorReady;
    logToFile("[EditorMonitor] start() called");

    // Monkey-patch Zotero.Notes.registerEditorInstance to intercept new editors
    try {
      this.originalRegister =
        Zotero.Notes.registerEditorInstance.bind(Zotero.Notes);
      const monitor = this;
      Zotero.Notes.registerEditorInstance = function (
        instance: Zotero.EditorInstance,
      ) {
        logToFile("[EditorMonitor] registerEditorInstance intercepted!");
        monitor.originalRegister!.call(Zotero.Notes, instance);
        monitor.onEditorRegistered(instance);
      };
      logToFile("[EditorMonitor] Monkey-patch applied");
    } catch (e) {
      logToFile("[EditorMonitor] Monkey-patch FAILED: " + e);
    }

    // Check already-open editors
    const existing = Zotero.Notes._editorInstances;
    logToFile(
      "[EditorMonitor] " + existing.length + " editors already open",
    );
    for (const instance of existing) {
      this.onEditorRegistered(instance);
    }

    logToFile("[EditorMonitor] Started (monkey-patch, zero polling)");
  }

  /**
   * Handle a newly registered editor instance.
   */
  private static async onEditorRegistered(
    instance: Zotero.EditorInstance,
  ): Promise<void> {
    if (this.attachedEditors.has(instance)) return;
    this.attachedEditors.add(instance);

    logToFile("[EditorMonitor] onEditorRegistered called");

    try {
      // Wait for editor to be fully initialized
      if (instance._initPromise) {
        logToFile("[EditorMonitor] Waiting for _initPromise...");
        await instance._initPromise;
        logToFile("[EditorMonitor] _initPromise resolved");
      }

      logToFile(
        "[EditorMonitor] _iframeWindow? " + !!instance._iframeWindow,
      );

      if (!instance._iframeWindow) {
        logToFile("[EditorMonitor] No _iframeWindow, retrying in 1s...");
        await new Promise((r) => setTimeout(r, 1000));
        logToFile(
          "[EditorMonitor] _iframeWindow after retry? " +
            !!instance._iframeWindow,
        );
        if (!instance._iframeWindow) {
          logToFile("[EditorMonitor] Still no _iframeWindow, skipping");
          return;
        }
      }

      logToFile("[EditorMonitor] Editor ready, calling callback");
      this.callback?.(instance);
    } catch (e) {
      logToFile("[EditorMonitor] Error during editor setup: " + e);
    }
  }

  /**
   * Stop monitoring.
   */
  static stop(): void {
    if (this.originalRegister) {
      try {
        Zotero.Notes.registerEditorInstance = this.originalRegister as any;
      } catch {
        // May fail if already cleaned up
      }
      this.originalRegister = null;
    }

    this.callback = null;
    logToFile("[EditorMonitor] Stopped");
  }
}
