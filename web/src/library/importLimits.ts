/**
 * The largest book file the library takes, in MB. A bigger file would be held in memory several times
 * while it is added and would fill the browser's storage. Kept apart from the importer, so the backup
 * code can use it without loading pdf.js.
 */
export const MAX_IMPORT_MB = 500
