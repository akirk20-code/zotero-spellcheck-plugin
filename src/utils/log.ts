/**
 * File-based debug logger.
 * Writes to %TEMP%/spellcheck-plugin.log since Zotero.debug()
 * doesn't appear in the Debug Output viewer for sandbox plugins.
 *
 * Only active in development mode to avoid writing user content
 * (annotation text, words) to disk in production.
 */

export function logToFile(msg: string): void {
  if (__env__ !== "development") return;

  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    const tmpDir = Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsIProperties)
      .get("TmpD", Ci.nsIFile) as nsIFile;

    // Use platform-agnostic path construction
    const clone = tmpDir.clone();
    clone.append("spellcheck-plugin.log");
    file.initWithPath(clone.path);

    const fos = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
      Ci.nsIFileOutputStream,
    );
    // 0x02=write, 0x08=create, 0x10=append; 0o600=owner-only
    fos.init(file, 0x02 | 0x08 | 0x10, 0o600, 0);

    // Sanitize control characters to prevent log injection
    const sanitized = msg.replace(/[\r\n\x00]/g, "\\n");
    const line = new Date().toISOString() + " " + sanitized + "\n";
    fos.write(line, line.length);
    fos.close();
  } catch {
    // Silently fail — logging should never break the plugin
  }
}
