import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { SpellEngine } from "./modules/spell-engine";
import { EditorMonitor } from "./modules/editor-monitor";
import { ReaderMonitor } from "./modules/reader-monitor";
import { SpellMenu } from "./modules/spell-menu";
import { logToFile } from "./utils/log";

async function onStartup() {
  logToFile("[hooks] onStartup called");
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  logToFile("[hooks] Zotero ready");

  initLocale();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Initialize spell checking engine
  logToFile("[hooks] Calling SpellEngine.init()");
  const engineReady = SpellEngine.init();
  logToFile("[hooks] SpellEngine.init() = " + engineReady);
  if (!engineReady) {
    new ztoolkit.ProgressWindow("Spell Check")
      .createLine({
        text: "No spell check dictionaries available",
        type: "error",
      })
      .show();
    addon.data.initialized = true;
    return;
  }

  // Start monitoring for note editors and attach spell menu
  logToFile("[hooks] Starting EditorMonitor");
  EditorMonitor.start((editorInstance) => {
    logToFile("[hooks] EditorMonitor callback fired - attaching SpellMenu");
    SpellMenu.attachToEditor(editorInstance);
  });

  // Start monitoring for PDF reader annotation comment fields
  logToFile("[hooks] Starting ReaderMonitor");
  ReaderMonitor.start(
    (element, iframeWindow) => {
      logToFile(
        "[hooks] ReaderMonitor callback fired - attaching SpellMenu to " +
          element.tagName,
      );
      SpellMenu.attachToReaderElement(element, iframeWindow);
    },
    (doc, iframeWindow) => {
      logToFile(
        "[hooks] ReaderMonitor document ready - attaching document-level listener",
      );
      SpellMenu.attachToReaderDocument(doc, iframeWindow);
    },
  );

  addon.data.initialized = true;
  logToFile("[hooks] Initialization complete");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  EditorMonitor.stop();
  ReaderMonitor.stop();
  SpellMenu.cleanupAll();
  SpellEngine.destroy();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(type: string) {
  ztoolkit.log("shortcut", type);
}

function onDialogEvents(type: string) {
  ztoolkit.log("dialogEvent", type);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
