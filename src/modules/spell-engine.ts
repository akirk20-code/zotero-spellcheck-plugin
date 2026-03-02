/**
 * Spell Checking Engine
 *
 * Wraps Firefox/Gecko's mozISpellCheckingEngine (Hunspell) XPCOM service
 * to provide spell checking and suggestions without needing an nsIEditor reference.
 */

import { config } from "../../package.json";

export class SpellEngine {
  private static engine: mozISpellCheckingEngine | null = null;
  private static personalDict: mozIPersonalDictionary | null = null;
  private static initialized = false;

  /**
   * Initialize the spell checking engine.
   * Detects the user's dictionary from Zotero preferences.
   */
  static init(): boolean {
    if (this.initialized) return true;

    try {
      this.engine = Cc["@mozilla.org/spellchecker/engine;1"].getService(
        Ci.mozISpellCheckingEngine,
      );

      // Detect dictionary from Zotero/Firefox preferences
      const dictionaries = this.detectDictionaries();
      if (dictionaries.length > 0) {
        this.engine.dictionaries = dictionaries;
        Zotero.debug(
          `SpellEngine: Using dictionaries: ${dictionaries.join(", ")}`,
        );
      } else {
        Zotero.debug("SpellEngine: No dictionaries available");
        return false;
      }

      // Get personal dictionary for "Add to Dictionary" feature
      this.personalDict = Cc[
        "@mozilla.org/spellchecker/personaldictionary;1"
      ].getService(Ci.mozIPersonalDictionary);

      this.initialized = true;
      Zotero.debug("SpellEngine: Initialized successfully");
      return true;
    } catch (e) {
      Zotero.debug("SpellEngine: Failed to initialize");
      Zotero.debug(e);
      return false;
    }
  }

  /**
   * Detect which dictionaries to use based on Zotero/Firefox preferences.
   */
  private static detectDictionaries(): string[] {
    const available = this.engine!.getDictionaryList();
    if (available.length === 0) return [];

    // Try spellchecker.dictionary pref first (Firefox standard)
    try {
      const prefDict = Zotero.Prefs.get(
        "spellchecker.dictionary",
        true,
      ) as string;
      if (prefDict && available.includes(prefDict)) {
        return [prefDict];
      }
    } catch {
      // Pref not set
    }

    // Try matching Zotero's locale
    try {
      const locale = Zotero.locale || "en-US";
      // Try exact match first (e.g. "en-US"), then language prefix (e.g. "en")
      if (available.includes(locale)) return [locale];
      const lang = locale.split("-")[0];
      const match = available.find((d: string) => d.startsWith(lang));
      if (match) return [match];
    } catch {
      // Locale not available
    }

    // Fallback: use first available dictionary
    return [available[0]];
  }

  /**
   * Check if a word is misspelled.
   */
  static isMisspelled(word: string): boolean {
    if (!this.engine || !this.initialized) {
      // Lazy re-init: handles hot-reload where old listeners call a destroyed engine
      if (!this.init()) return false;
    }
    if (!word || word.length < 2) return false;

    // Skip words that are all numbers
    if (/^\d+$/.test(word)) return false;

    try {
      // Check personal dictionary first
      if (this.personalDict?.check(word)) return false;

      return !this.engine!.check(word);
    } catch (e) {
      Zotero.debug(`SpellEngine: Error checking word "${word}"`);
      Zotero.debug(e);
      return false;
    }
  }

  /**
   * Get spelling suggestions for a misspelled word.
   */
  static getSuggestions(word: string, maxCount?: number): string[] {
    if (!this.engine || !this.initialized) {
      if (!this.init()) return [];
    }

    const count =
      maxCount ??
      ((Zotero.Prefs.get(`${config.prefsPrefix}.suggestionCount`, true) as
        | number
        | undefined) ||
        5);

    try {
      return this.engine!.suggest(word).slice(0, count);
    } catch (e) {
      Zotero.debug(`SpellEngine: Error getting suggestions for "${word}"`);
      Zotero.debug(e);
      return [];
    }
  }

  /**
   * Add a word to the personal dictionary.
   */
  static addToDictionary(word: string): void {
    if (!this.personalDict) return;

    const sanitized = this.sanitizeWord(word);
    if (!sanitized) return;

    try {
      this.personalDict.addWord(sanitized);
      this.personalDict.save();
      Zotero.debug(`SpellEngine: Added "${sanitized}" to personal dictionary`);
    } catch (e) {
      Zotero.debug(`SpellEngine: Error adding "${sanitized}" to dictionary`);
      Zotero.debug(e);
    }
  }

  /**
   * Sanitize a word — only letters, numbers, apostrophes, and hyphens.
   */
  private static sanitizeWord(word: string): string {
    return word.replace(/[^\p{L}\p{N}'-]/gu, "");
  }

  /**
   * Cleanup on shutdown.
   */
  static destroy(): void {
    this.engine = null;
    this.personalDict = null;
    this.initialized = false;
  }
}
