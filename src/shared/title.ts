/**
 * The default title for a document: its file name without the extension.
 *
 * The title becomes the item's name in 1Password, where ".pdf" is noise; the
 * file itself keeps its full name inside the item. Used by the core (so the
 * CLI and a blank title agree), and by the window to pre-fill the title, so
 * the same file always gets the same default and the duplicate check, which
 * compares titles exactly, keeps working across all of them.
 *
 * No imports: this runs in the sandboxed window as well as in Node.
 */
export function defaultTitle(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  // A leading dot (".env") is part of the name, not an extension; and a file
  // with no dot keeps its whole name.
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
