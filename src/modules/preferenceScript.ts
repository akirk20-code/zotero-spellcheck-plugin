import { config } from "../../package.json";

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    };
  } else {
    addon.data.prefs.window = _window;
  }

  updatePrefsUI();
  bindPrefEvents();
}

async function updatePrefsUI() {
  if (!addon.data.prefs?.window) return;

  const doc = addon.data.prefs.window.document;

  // Set initial values from preferences
  const suggestionCountInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-suggestion-count`,
  ) as HTMLInputElement;

  if (suggestionCountInput) {
    const count = Zotero.Prefs.get(
      `${config.prefsPrefix}.suggestionCount`,
      true,
    ) as number;
    suggestionCountInput.value = String(count || 5);
  }

  ztoolkit.log("Spell check preferences UI updated");
}

function bindPrefEvents() {
  if (!addon.data.prefs?.window?.document) return;

  const doc = addon.data.prefs.window.document;

  // Bind suggestion count input
  const suggestionCountInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-suggestion-count`,
  );

  suggestionCountInput?.addEventListener("change", (e: Event) => {
    const value = parseInt((e.target as HTMLInputElement).value);
    if (!isNaN(value) && value >= 1 && value <= 10) {
      Zotero.Prefs.set(`${config.prefsPrefix}.suggestionCount`, value, true);
      ztoolkit.log(`Spell check suggestion count set to ${value}`);
    } else {
      // Reset to default if invalid
      (e.target as HTMLInputElement).value = "5";
      Zotero.Prefs.set(`${config.prefsPrefix}.suggestionCount`, 5, true);
      addon.data.prefs!.window.alert(
        "Suggestion count must be between 1 and 10. Reset to default (5).",
      );
    }
  });

  ztoolkit.log("Spell check preference events bound");
}
