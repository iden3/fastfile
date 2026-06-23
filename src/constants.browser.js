// Browser stub for the Node "constants" module, mapped via the package.json
// "browser" field. fastfile.js does a NAMED import of these open-mode flags, so
// the stub must provide them as named exports (an empty `false` stub has none
// and would fail the named import). The values are never used in the browser:
// file operations go through the Node-only OsFile path, while browsers use
// MemFile. They exist only so the import resolves.
export const O_TRUNC = 0;
export const O_CREAT = 0;
export const O_RDWR = 0;
export const O_EXCL = 0;
export const O_RDONLY = 0;
