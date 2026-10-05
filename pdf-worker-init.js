// Loads pdf.js and points it at its worker script, then exposes the
// library as window.pdfjsLib so the rest of app.js (openAttachmentViewer)
// can keep using the same `window.pdfjsLib` / `pdfjsLib.GlobalWorkerOptions`
// calls it always has.
//
// As of v1.9.4 this is an ES module (loaded via <script type="module">
// in index.html) because pdfjs-dist 4.0+ dropped the old UMD/global-script
// build (pdf.min.js) in favor of pdf.min.mjs — pdf.js stopped publishing a
// non-module browser bundle starting with that release. The CSP's
// script-src 'self' (no 'unsafe-inline') is satisfied the same way as
// before: this is still an external, same-origin file, module scripts are
// just a different <script> loading mode, not a CSP exception.
//
// Vendored locally from npm pdfjs-dist@6.4.299 — see vendor/pdfjs-6.4.299/.
// (6.2.108 was the first release past the CVE-2024-4367 fix, 4.2.67 upstream;
// pdfjs-dist@3.11.174 was used through v1.9.3.) Since a PDF attachment in this
// app can come from anywhere the user imports it from (not just files they
// created themselves), staying current on pdf.js matters.
//
// v1.9.18: pdf.js now lives in a folder whose name carries the version, and
// EVERY path to it (the main file imported below, the worker, the wasm/ image
// decoders used by app.js) is built from the one constant here. The main file
// and the worker MUST be the same release: a 6.2.108 main file with a 6.4.299
// worker never gets an answer ("Unknown action from worker: test") and the
// viewer hangs on "Loading…". With fixed file names and a cache-first service
// worker one file of the pair can come from an old cache and the other from the
// new one during an update; version-named paths can never be mixed that way.
// To update pdf.js: put the new release's build/ files + wasm/ folder in a NEW
// vendor/pdfjs-<version>/ folder, then change only PDFJS_DIR here and the
// './vendor/pdfjs-…' lines in STATIC_ASSETS in sw.js.
const PDFJS_DIR = 'vendor/pdfjs-6.4.299/';
const pdfjsLib = await import('./' + PDFJS_DIR + 'pdf.min.mjs');

pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_DIR + 'pdf.worker.min.mjs';
window.pdfjsLib = pdfjsLib;
// Where app.js finds the image decoders (see openPdfDocument() there).
window.PDFJS_WASM_URL = new URL(PDFJS_DIR + 'wasm/', document.baseURI).href;
