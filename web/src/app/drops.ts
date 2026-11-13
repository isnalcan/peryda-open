/**
 * A file dropped anywhere the app does not take files (a reader, a dialog, the EPUB frame) is ignored.
 * Left to the browser, the drop would navigate the whole window to the file, and on Windows there is no
 * address bar to come back. The library's own drop zone still gets the event first and adds the book.
 */
export function ignoreStrayDrops(target: Pick<EventTarget, 'addEventListener'>): void {
  const stop = (e: Event) => e.preventDefault()
  target.addEventListener('dragover', stop)
  target.addEventListener('drop', stop)
}
