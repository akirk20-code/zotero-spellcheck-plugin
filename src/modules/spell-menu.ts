/**
 * Spell Check Context Menu
 *
 * Attaches to note editor contenteditable elements and shows a custom
 * XUL popup with spell suggestions when a misspelled word is right-clicked.
 * For correctly-spelled words, Zotero's normal context menu appears.
 */

import { SpellEngine } from "./spell-engine";
import { getString } from "../utils/locale";
import { logToFile } from "../utils/log";

export class SpellMenu {
  private static POPUP_ID = "spellcheck-context-popup";
  private static attachedEditors = new WeakSet<Zotero.EditorInstance>();
  private static attachedElements = new WeakSet<HTMLElement>();
  private static attachedReaderDocs = new WeakSet<Document>();

  /**
   * Attach spell check context menu to a note editor instance.
   * Called by EditorMonitor when an editor is ready.
   */
  static attachToEditor(editorInstance: Zotero.EditorInstance): void {
    if (this.attachedEditors.has(editorInstance)) return;
    this.attachedEditors.add(editorInstance);

    logToFile("[SpellMenu] attachToEditor called");

    const iframeWin = editorInstance._iframeWindow;
    logToFile("[SpellMenu] _iframeWindow exists? " + !!iframeWin);
    if (!iframeWin) return;

    const iframeDoc = iframeWin.document;
    Zotero.debug(
      `SpellMenu: iframeDoc URL: ${iframeDoc?.location?.href}`,
    );

    // Log the DOM structure to understand what we're working with
    const allIframes = iframeDoc.querySelectorAll("iframe");
    Zotero.debug(
      `SpellMenu: Found ${allIframes.length} nested iframes in editor`,
    );

    // Try finding contenteditable at this level
    let editable = iframeDoc.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement | null;

    Zotero.debug(
      `SpellMenu: contenteditable at top level? ${!!editable}`,
    );

    // If not found, search inside nested iframes
    if (!editable && allIframes.length > 0) {
      for (let i = 0; i < allIframes.length; i++) {
        const nestedIframe = allIframes[i] as HTMLIFrameElement;
        try {
          const nestedDoc =
            nestedIframe.contentDocument ||
            nestedIframe.contentWindow?.document;
          if (nestedDoc) {
            Zotero.debug(
              `SpellMenu: Nested iframe[${i}] URL: ${nestedDoc.location?.href}`,
            );
            const nestedEditable = nestedDoc.querySelector(
              '[contenteditable="true"]',
            ) as HTMLElement | null;
            Zotero.debug(
              `SpellMenu: Nested iframe[${i}] has contenteditable? ${!!nestedEditable}`,
            );
            if (nestedEditable) {
              editable = nestedEditable;
              // Also search deeper
              const deepIframes = nestedDoc.querySelectorAll("iframe");
              Zotero.debug(
                `SpellMenu: Nested iframe[${i}] has ${deepIframes.length} deeper iframes`,
              );
              break;
            }
          }
        } catch (e) {
          Zotero.debug(
            `SpellMenu: Cannot access nested iframe[${i}] (cross-origin?)`,
          );
        }
      }
    }

    // Also log body content summary for debugging
    const bodyChildren = iframeDoc.body?.children;
    if (bodyChildren) {
      const tags = Array.from(bodyChildren)
        .slice(0, 10)
        .map(
          (el) =>
            `${el.tagName}${el.id ? "#" + el.id : ""}${el.className ? "." + String(el.className).split(" ")[0] : ""}`,
        );
      Zotero.debug(`SpellMenu: Body children: ${tags.join(", ")}`);
    }

    if (!editable) {
      logToFile("[SpellMenu] No contenteditable found - using fallback on iframeDoc");
      iframeDoc.addEventListener(
        "contextmenu",
        (event: MouseEvent) => {
          logToFile("[SpellMenu] [fallback] contextmenu fired on " + (event.target as Element)?.tagName);
          this.handleContextMenu(event, editorInstance);
        },
        true,
      );
      return;
    }

    // Listen for right-click on the editable area
    logToFile("[SpellMenu] Attaching contextmenu to contenteditable");
    editable.addEventListener(
      "contextmenu",
      (event: MouseEvent) => {
        logToFile("[SpellMenu] contextmenu fired on " + (event.target as Element)?.tagName);
        this.handleContextMenu(event, editorInstance);
      },
      true, // capture phase to get it before ProseMirror
    );

    logToFile("[SpellMenu] Attached to editor contenteditable element");
  }

  /**
   * Handle the contextmenu event on the note editor.
   */
  private static handleContextMenu(
    event: MouseEvent,
    editorInstance: Zotero.EditorInstance,
  ): void {
    logToFile("[SpellMenu] handleContextMenu called");
    const doc = (event.target as Element).ownerDocument;
    if (!doc) {
      Zotero.debug("SpellMenu: No ownerDocument on target");
      return;
    }

    // Get the word at the right-click position
    const wordInfo = this.getWordAtPoint(doc, event.clientX, event.clientY);
    logToFile(
      "[SpellMenu] Editor word: " +
        (wordInfo ? '"' + wordInfo.word + '"' : "null"),
    );
    if (!wordInfo) return;

    // Check if the word is misspelled
    const misspelled = SpellEngine.isMisspelled(wordInfo.word);
    logToFile(
      '[SpellMenu] Editor "' + wordInfo.word + '" misspelled? ' + misspelled,
    );
    if (!misspelled) {
      // Not misspelled — let Zotero's normal menu appear
      return;
    }

    // Always use the main Zotero window for XUL popup creation.
    // Editor iframes may be inside <browser> elements where .top
    // gives an HTML document without createXULElement.
    const chromeWin = Zotero.getMainWindow();
    if (!chromeWin) {
      logToFile("[SpellMenu] No chrome window available");
      return;
    }

    if (typeof (chromeWin.document as any).createXULElement !== "function") {
      logToFile("[SpellMenu] Chrome window has no createXULElement");
      return;
    }

    // Misspelled word detected — prevent default and show our menu
    event.preventDefault();
    event.stopPropagation();

    const suggestions = SpellEngine.getSuggestions(wordInfo.word);
    logToFile(
      "[SpellMenu] Suggestions: " + JSON.stringify(suggestions),
    );

    try {
      this.showPopup(
        chromeWin.document,
        event,
        wordInfo,
        suggestions,
        editorInstance,
      );
      logToFile("[SpellMenu] Popup shown for editor");
    } catch (e) {
      logToFile("[SpellMenu] Error showing editor popup: " + e);
    }
  }

  /**
   * Get the word at a specific point in the document.
   * Uses caretPositionFromPoint (Firefox/Gecko) with fallback to
   * caretRangeFromPoint (WebKit/Blink).
   */
  private static getWordAtPoint(
    doc: Document,
    clientX: number,
    clientY: number,
  ): { word: string; range: Range } | null {
    try {
      let textNode: Node | null = null;
      let offset = 0;

      // Firefox/Gecko: caretPositionFromPoint
      const caretPos = (doc as any).caretPositionFromPoint?.(clientX, clientY);
      if (caretPos) {
        textNode = caretPos.offsetNode;
        offset = caretPos.offset;
        logToFile(
          "[SpellMenu] caretPositionFromPoint: node=" +
            textNode?.nodeName +
            " type=" +
            textNode?.nodeType +
            " offset=" +
            offset,
        );
      } else {
        // Fallback: caretRangeFromPoint (WebKit)
        const caretRange = (doc as any).caretRangeFromPoint?.(
          clientX,
          clientY,
        );
        if (caretRange) {
          textNode = caretRange.startContainer;
          offset = caretRange.startOffset;
          logToFile(
            "[SpellMenu] caretRangeFromPoint: node=" +
              textNode?.nodeName +
              " type=" +
              textNode?.nodeType +
              " offset=" +
              offset,
          );
        }
      }

      if (!textNode) {
        logToFile("[SpellMenu] No caret position found at (" + clientX + "," + clientY + ")");
        return null;
      }

      // Node.TEXT_NODE === 3 (use literal since Node global may not exist in sandbox)
      if (textNode.nodeType !== 3) {
        logToFile("[SpellMenu] Not a text node: " + textNode.nodeName + " type=" + textNode.nodeType);
        return null;
      }

      const text = textNode.textContent || "";
      logToFile(
        "[SpellMenu] Text content: \"" +
          text.substring(Math.max(0, offset - 10), offset + 10) +
          "\" offset=" +
          offset,
      );

      // Expand to word boundaries (Unicode-aware)
      const wordChar = /[\p{L}\p{N}_'-]/u;
      let start = offset;
      let end = offset;

      while (start > 0 && wordChar.test(text[start - 1])) start--;
      while (end < text.length && wordChar.test(text[end])) end++;

      const word = text.substring(start, end);
      if (!word || word.length < 2) {
        logToFile("[SpellMenu] Word too short or empty: \"" + word + "\"");
        return null;
      }

      logToFile("[SpellMenu] Detected word: \"" + word + "\"");

      const wordRange = doc.createRange();
      wordRange.setStart(textNode, start);
      wordRange.setEnd(textNode, end);

      return { word, range: wordRange };
    } catch (e) {
      logToFile("[SpellMenu] Error getting word at point: " + e);
      return null;
    }
  }

  /**
   * Get the chrome (XUL) window for an editor instance.
   * Handles inline pane, tab, and separate window contexts.
   */
  private static getChromeWindow(
    editorInstance: Zotero.EditorInstance,
  ): Window | null {
    try {
      // The iframe's top-level window is the chrome window
      const top = editorInstance._iframeWindow?.top;
      if (top) return top;
    } catch {
      // Cross-origin restriction
    }

    // Fallback to main Zotero window
    return Zotero.getMainWindow();
  }

  /**
   * Show the spell check popup menu at the mouse position.
   */
  private static showPopup(
    chromeDoc: Document,
    event: MouseEvent,
    wordInfo: { word: string; range: Range },
    suggestions: string[],
    editorInstance: Zotero.EditorInstance,
  ): void {
    // Remove any existing popup
    this.removePopup(chromeDoc);

    const popup = chromeDoc.createXULElement("menupopup") as any;
    popup.id = this.POPUP_ID;

    // --- Spell suggestions ---
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        const item = chromeDoc.createXULElement("menuitem") as any;
        item.setAttribute("label", suggestion);
        item.style.fontWeight = "bold";
        item.addEventListener("command", () => {
          this.replaceWord(wordInfo.range, suggestion, editorInstance);
        });
        popup.appendChild(item);
      }
    } else {
      const noSugg = chromeDoc.createXULElement("menuitem") as any;
      noSugg.setAttribute("label", getString("spellcheck-no-suggestions"));
      noSugg.setAttribute("disabled", "true");
      popup.appendChild(noSugg);
    }

    // --- Separator ---
    popup.appendChild(chromeDoc.createXULElement("menuseparator"));

    // --- Add to Dictionary ---
    const addDict = chromeDoc.createXULElement("menuitem") as any;
    addDict.setAttribute("label", getString("spellcheck-add-to-dictionary"));
    addDict.addEventListener("command", () => {
      SpellEngine.addToDictionary(wordInfo.word);
      // Force re-spellcheck by toggling the spellcheck attribute
      this.triggerRespellcheck(editorInstance);
    });
    popup.appendChild(addDict);

    // --- Separator ---
    popup.appendChild(chromeDoc.createXULElement("menuseparator"));

    // --- Standard clipboard actions ---
    const iframeWin = editorInstance._iframeWindow;
    const iframeDoc = iframeWin?.document;

    const cutItem = chromeDoc.createXULElement("menuitem") as any;
    cutItem.setAttribute("label", "Cut");
    cutItem.addEventListener("command", () => {
      iframeDoc?.execCommand("cut");
    });
    popup.appendChild(cutItem);

    const copyItem = chromeDoc.createXULElement("menuitem") as any;
    copyItem.setAttribute("label", "Copy");
    copyItem.addEventListener("command", () => {
      iframeDoc?.execCommand("copy");
    });
    popup.appendChild(copyItem);

    const pasteItem = chromeDoc.createXULElement("menuitem") as any;
    pasteItem.setAttribute("label", "Paste");
    pasteItem.addEventListener("command", () => {
      iframeDoc?.execCommand("paste");
    });
    popup.appendChild(pasteItem);

    // Append to chrome document and show
    const root = chromeDoc.documentElement ?? chromeDoc.body;
    if (!root) return;
    root.appendChild(popup);

    // Use screen coordinates — correct regardless of iframe nesting
    popup.openPopupAtScreen(event.screenX, event.screenY, true);

    // Clean up when popup closes
    popup.addEventListener(
      "popuphidden",
      () => {
        popup.remove();
      },
      { once: true },
    );
  }

  /**
   * Replace the misspelled word using execCommand("insertText").
   * This goes through ProseMirror's beforeinput handler, preserving
   * undo/redo and editor state consistency.
   */
  private static replaceWord(
    wordRange: Range,
    replacement: string,
    editorInstance: Zotero.EditorInstance,
  ): void {
    try {
      const iframeWin = editorInstance._iframeWindow;
      if (!iframeWin) return;

      const iframeDoc = iframeWin.document;

      // Select the misspelled word
      const selection = iframeWin.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(wordRange);

      // Replace via execCommand — ProseMirror handles this as an input event
      iframeDoc.execCommand("insertText", false, replacement);

      Zotero.debug(`SpellMenu: Replaced with "${replacement}"`);
    } catch (e) {
      Zotero.debug("SpellMenu: Error replacing word");
      Zotero.debug(e);
    }
  }

  /**
   * Force the editor to re-run spell checking.
   * Toggles the spellcheck attribute to make Gecko recheck.
   */
  private static triggerRespellcheck(
    editorInstance: Zotero.EditorInstance,
  ): void {
    try {
      const iframeDoc = editorInstance._iframeWindow?.document;
      if (!iframeDoc) return;

      const editable = iframeDoc.querySelector(
        '[contenteditable="true"]',
      ) as HTMLElement | null;
      if (!editable) return;

      // Toggle spellcheck off and on to force re-check
      editable.setAttribute("spellcheck", "false");
      // Use requestAnimationFrame to ensure the change takes effect
      editorInstance._iframeWindow.requestAnimationFrame(() => {
        editable.setAttribute("spellcheck", "true");
      });
    } catch (e) {
      Zotero.debug("SpellMenu: Error triggering re-spellcheck");
      Zotero.debug(e);
    }
  }

  /**
   * Attach spell check context menu to a reader editable element
   * (textarea or contenteditable div in PDF reader annotation sidebar).
   * Called by ReaderMonitor when an editable element is found.
   */
  static attachToReaderElement(
    element: HTMLElement,
    iframeWindow: Window,
  ): void {
    if (this.attachedElements.has(element)) return;
    this.attachedElements.add(element);

    logToFile(
      "[SpellMenu] attachToReaderElement: " +
        element.tagName +
        (element.className ? "." + element.className : ""),
    );

    element.addEventListener(
      "contextmenu",
      (event: MouseEvent) => {
        logToFile(
          "[SpellMenu] Reader contextmenu on " + element.tagName,
        );
        this.handleReaderContextMenu(event, element, iframeWindow);
      },
      true,
    );

    // Also ensure a document-level listener is in place as a safety net.
    // React may replace elements, making per-element listeners stale.
    const doc = element.ownerDocument;
    if (doc) {
      this.attachToReaderDocument(doc, iframeWindow);
    }
  }

  /**
   * Attach a document-level contextmenu listener to a reader document.
   * This catches right-clicks on editable elements even if they were
   * dynamically created after per-element listeners were attached.
   * Idempotent — safe to call multiple times per document.
   */
  static attachToReaderDocument(
    doc: Document,
    iframeWindow: Window,
  ): void {
    if (this.attachedReaderDocs.has(doc)) return;
    this.attachedReaderDocs.add(doc);

    logToFile("[SpellMenu] Attaching document-level contextmenu listener");

    doc.addEventListener(
      "contextmenu",
      (event: Event) => {
        const mouseEvent = event as MouseEvent;
        const target = mouseEvent.target as HTMLElement;
        if (!target) return;

        // Find the editable element (target itself or an ancestor)
        const editable = this.findEditableElement(target);
        if (!editable) return;

        logToFile(
          "[SpellMenu] Document-level contextmenu on " +
            editable.tagName +
            (editable.className
              ? "." + String(editable.className).split(" ")[0]
              : ""),
        );
        this.handleReaderContextMenu(mouseEvent, editable, iframeWindow);
      },
      true, // capture phase — fires before bubble-phase handlers
    );
  }

  /**
   * Find the nearest editable element (textarea, input, or contenteditable).
   */
  private static findEditableElement(
    target: HTMLElement,
  ): HTMLElement | null {
    if (!target) return null;

    // Check if target itself is editable
    if (
      target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT" ||
      target.getAttribute?.("contenteditable") === "true" ||
      target.getAttribute?.("contenteditable") === ""
    ) {
      return target;
    }

    // Walk up the DOM to find an editable ancestor
    const editable = target.closest(
      'textarea, input, [contenteditable="true"], [contenteditable=""]',
    ) as HTMLElement | null;
    return editable;
  }

  /**
   * Handle contextmenu on a reader editable element.
   * Note: No deduplication guard — stopPropagation() naturally prevents
   * document→element double-firing. Removing the guard avoids hot-reload
   * issues where stale listeners from old module loads block new ones.
   */
  private static handleReaderContextMenu(
    event: MouseEvent,
    element: HTMLElement,
    iframeWindow: Window,
  ): void {
    logToFile("[SpellMenu] handleReaderContextMenu called");

    let wordInfo: {
      word: string;
      range?: Range;
      textareaStart?: number;
      textareaEnd?: number;
    } | null = null;

    const isTextarea =
      element.tagName === "TEXTAREA" || element.tagName === "INPUT";

    if (isTextarea) {
      wordInfo = this.getWordInTextarea(element as HTMLTextAreaElement);
    } else {
      const doc = element.ownerDocument!;
      const rangeInfo = this.getWordAtPoint(doc, event.clientX, event.clientY);
      if (rangeInfo) {
        wordInfo = { word: rangeInfo.word, range: rangeInfo.range };
      }
    }

    logToFile(
      "[SpellMenu] Reader word: " + (wordInfo ? '"' + wordInfo.word + '"' : "null"),
    );
    if (!wordInfo) return;

    const misspelled = SpellEngine.isMisspelled(wordInfo.word);
    logToFile(
      '[SpellMenu] Reader "' + wordInfo.word + '" misspelled? ' + misspelled,
    );
    if (!misspelled) return;

    // Always use the main Zotero window for XUL popup creation.
    // Reader iframes are inside <browser> elements, so iframeWindow.top
    // gives us an HTML document (not XUL), where createXULElement doesn't exist.
    const chromeWin = Zotero.getMainWindow();
    if (!chromeWin) {
      logToFile("[SpellMenu] No chrome window available");
      return;
    }

    // Verify XUL support before suppressing default menu
    if (typeof (chromeWin.document as any).createXULElement !== "function") {
      logToFile("[SpellMenu] Chrome window has no createXULElement");
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const suggestions = SpellEngine.getSuggestions(wordInfo.word);
    logToFile("[SpellMenu] Suggestions: " + JSON.stringify(suggestions));

    try {
      this.showReaderPopup(
        chromeWin.document,
        event,
        wordInfo,
        suggestions,
        element,
        iframeWindow,
      );
    } catch (e) {
      logToFile("[SpellMenu] Error showing reader popup: " + e);
    }
  }

  /**
   * Get word at caret position in a textarea.
   * In Firefox, right-clicking moves the caret to the click position.
   */
  private static getWordInTextarea(
    textarea: HTMLTextAreaElement,
  ): {
    word: string;
    textareaStart: number;
    textareaEnd: number;
  } | null {
    try {
      const text = textarea.value;
      const pos = textarea.selectionStart;
      logToFile(
        "[SpellMenu] textarea: selectionStart=" +
          pos +
          " textLen=" +
          text.length +
          ' text="' +
          text.substring(0, 50) +
          (text.length > 50 ? "..." : "") +
          '"',
      );
      if (pos === null || pos === undefined) return null;

      const wordChar = /[\p{L}\p{N}_'-]/u;
      let start = pos;
      let end = pos;

      while (start > 0 && wordChar.test(text[start - 1])) start--;
      while (end < text.length && wordChar.test(text[end])) end++;

      const word = text.substring(start, end);
      logToFile(
        "[SpellMenu] textarea word: \"" +
          word +
          "\" [" +
          start +
          ":" +
          end +
          "]",
      );
      if (!word || word.length < 2) return null;

      return { word, textareaStart: start, textareaEnd: end };
    } catch (e) {
      logToFile("[SpellMenu] Error getting word in textarea: " + e);
      return null;
    }
  }

  /**
   * Show spell popup for a reader element.
   */
  private static showReaderPopup(
    chromeDoc: Document,
    event: MouseEvent,
    wordInfo: {
      word: string;
      range?: Range;
      textareaStart?: number;
      textareaEnd?: number;
    },
    suggestions: string[],
    element: HTMLElement,
    iframeWindow: Window,
  ): void {
    this.removePopup(chromeDoc);

    const popup = chromeDoc.createXULElement("menupopup") as any;
    popup.id = this.POPUP_ID;

    // Spell suggestions
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        const item = chromeDoc.createXULElement("menuitem") as any;
        item.setAttribute("label", suggestion);
        item.style.fontWeight = "bold";
        item.addEventListener("command", () => {
          this.replaceInReaderElement(
            element,
            iframeWindow,
            wordInfo,
            suggestion,
          );
        });
        popup.appendChild(item);
      }
    } else {
      const noSugg = chromeDoc.createXULElement("menuitem") as any;
      noSugg.setAttribute("label", getString("spellcheck-no-suggestions"));
      noSugg.setAttribute("disabled", "true");
      popup.appendChild(noSugg);
    }

    // Separator
    popup.appendChild(chromeDoc.createXULElement("menuseparator"));

    // Add to Dictionary
    const addDict = chromeDoc.createXULElement("menuitem") as any;
    addDict.setAttribute("label", getString("spellcheck-add-to-dictionary"));
    addDict.addEventListener("command", () => {
      SpellEngine.addToDictionary(wordInfo.word);
    });
    popup.appendChild(addDict);

    // Separator + clipboard actions
    popup.appendChild(chromeDoc.createXULElement("menuseparator"));

    const elDoc = element.ownerDocument;
    for (const cmd of ["cut", "copy", "paste"] as const) {
      const mi = chromeDoc.createXULElement("menuitem") as any;
      mi.setAttribute("label", cmd.charAt(0).toUpperCase() + cmd.slice(1));
      mi.addEventListener("command", () => {
        elDoc?.execCommand(cmd);
      });
      popup.appendChild(mi);
    }

    const root = chromeDoc.documentElement ?? chromeDoc.body;
    if (!root) return;
    root.appendChild(popup);

    popup.openPopupAtScreen(event.screenX, event.screenY, true);

    popup.addEventListener(
      "popuphidden",
      () => {
        popup.remove();
      },
      { once: true },
    );
  }

  /**
   * Replace word in a reader editable element.
   */
  private static replaceInReaderElement(
    element: HTMLElement,
    iframeWindow: Window,
    wordInfo: {
      word: string;
      range?: Range;
      textareaStart?: number;
      textareaEnd?: number;
    },
    replacement: string,
  ): void {
    try {
      if (
        element.tagName === "TEXTAREA" &&
        wordInfo.textareaStart !== undefined &&
        wordInfo.textareaEnd !== undefined
      ) {
        const textarea = element as HTMLTextAreaElement;
        const text = textarea.value;
        const newText =
          text.substring(0, wordInfo.textareaStart) +
          replacement +
          text.substring(wordInfo.textareaEnd);

        // Use native setter to trigger React's change detection
        const nativeSetter = Object.getOwnPropertyDescriptor(
          iframeWindow.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(textarea, newText);
        } else {
          textarea.value = newText;
        }

        // Fire events so React picks up the change
        textarea.dispatchEvent(new iframeWindow.Event("input", { bubbles: true }));
        textarea.dispatchEvent(new iframeWindow.Event("change", { bubbles: true }));

        // Restore cursor position
        const newPos = wordInfo.textareaStart + replacement.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;

        logToFile('[SpellMenu] Replaced in textarea: "' + replacement + '"');
      } else if (wordInfo.range) {
        // Contenteditable — use selection + execCommand
        const selection = iframeWindow.getSelection();
        if (!selection) return;
        selection.removeAllRanges();
        selection.addRange(wordInfo.range);
        element.ownerDocument!.execCommand("insertText", false, replacement);
        logToFile(
          '[SpellMenu] Replaced in contenteditable: "' + replacement + '"',
        );
      }
    } catch (e) {
      logToFile("[SpellMenu] Error replacing in reader element: " + e);
    }
  }

  /**
   * Remove any existing popup from the document.
   */
  private static removePopup(doc: Document): void {
    const existing = doc.getElementById(this.POPUP_ID);
    if (existing) existing.remove();
  }

  /**
   * Remove all popups from all windows. Called on shutdown.
   */
  static cleanupAll(): void {
    try {
      for (const win of Zotero.getMainWindows()) {
        this.removePopup(win.document);
      }
    } catch {
      // Windows may already be closed
    }
  }
}
