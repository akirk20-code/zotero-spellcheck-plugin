/**
 * Type definitions for Firefox/Mozilla-specific APIs
 * used by this plugin but not in standard TypeScript DOM types.
 *
 * Note: mozISpellCheckingEngine, mozIPersonalDictionary, nsIEditorSpellCheck,
 * and nsIInlineSpellChecker are fully typed in zotero-types
 * (lib.gecko.xpcom.d.ts) and do NOT need redefinition here.
 */

// Extend Document with Firefox/Gecko-specific caret APIs
interface Document {
  /**
   * Returns a CaretPosition for the caret at the given client coordinates.
   * Firefox/Gecko standard method (preferred over caretRangeFromPoint).
   */
  caretPositionFromPoint(
    x: number,
    y: number,
  ): { offsetNode: Node; offset: number } | null;

  /**
   * Returns a Range for the caret position at the given client coordinates.
   * WebKit/Blink method (fallback).
   */
  caretRangeFromPoint(x: number, y: number): Range | null;
}
