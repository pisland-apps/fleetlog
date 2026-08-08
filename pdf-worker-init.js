// Points pdf.js at its worker script. Kept as its own file (rather than an
// inline <script> in index.html) because the CSP's script-src has no
// 'unsafe-inline', so any inline script would simply be blocked.
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
