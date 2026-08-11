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
// Vendored locally from npm pdfjs-dist@6.2.108 — see vendor/pdfjs/. This
// upgrades past pdfjs-dist@3.11.174 (used through v1.9.3), which predates
// the fix for CVE-2024-4367 (arbitrary JS execution via a crafted font in
// a malicious PDF, patched in pdfjs-dist@4.2.67). Since a PDF attachment
// in this app can come from anywhere the user imports it from (not just
// files they created themselves), staying current on pdf.js matters.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';
window.pdfjsLib = pdfjsLib;
