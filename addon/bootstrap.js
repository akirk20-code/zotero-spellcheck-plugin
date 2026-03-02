/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

// Helper to append to our debug log file
function logToFile(msg) {
  try {
    var file = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    file.initWithPath(
      Components.classes["@mozilla.org/file/directory_service;1"]
        .getService(Components.interfaces.nsIProperties)
        .get("TmpD", Components.interfaces.nsIFile).path +
        "\\spellcheck-bootstrap.log",
    );
    var fos = Components.classes[
      "@mozilla.org/network/file-output-stream;1"
    ].createInstance(Components.interfaces.nsIFileOutputStream);
    // 0x02=write, 0x08=create, 0x10=append
    fos.init(file, 0x02 | 0x08 | 0x10, 0o644, 0);
    var line = new Date().toISOString() + " " + msg + "\n";
    fos.write(line, line.length);
    fos.close();
  } catch (e) {
    dump("logToFile error: " + e + "\n");
  }
}

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  logToFile("=== startup() called ===");
  logToFile("rootURI = " + rootURI);

  try {
    var aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    var manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "__addonRef__", rootURI + "content/"],
    ]);
    logToFile("chrome registered");

    const ctx = { rootURI };
    ctx._globalThis = ctx;

    var scriptURL = `${rootURI}/content/scripts/__addonRef__.js`;
    logToFile("loading script: " + scriptURL);

    Services.scriptloader.loadSubScript(scriptURL, ctx);
    logToFile("script loaded OK");

    logToFile(
      "Zotero.__addonInstance__ type = " + typeof Zotero.__addonInstance__,
    );
    logToFile(
      "Zotero.__addonInstance__.hooks type = " +
        typeof (Zotero.__addonInstance__ && Zotero.__addonInstance__.hooks),
    );

    await Zotero.__addonInstance__.hooks.onStartup();
    logToFile("onStartup() completed successfully");
  } catch (e) {
    logToFile("ERROR: " + e);
    logToFile("STACK: " + (e.stack || "no stack"));
    if (typeof Zotero !== "undefined" && Zotero.debug) {
      Zotero.debug("=== SpellCheck bootstrap ERROR: " + e + " ===");
    }
  }
}

async function onMainWindowLoad({ window }, reason) {
  logToFile("onMainWindowLoad called");
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  logToFile("shutdown called, reason=" + reason);
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
