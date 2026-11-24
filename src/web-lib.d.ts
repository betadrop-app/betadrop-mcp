// DOM type names the website's libraries (web/src/lib) mention, for this Node-only build, which
// compiles without the DOM lib. Node has the values themselves (Blob, Response, CompressionStream).
type BlobPart = import("node:buffer").BinaryLike | ArrayBuffer | Blob;
