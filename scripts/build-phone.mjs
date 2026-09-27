// Builds a single self-contained HTML file of Brain Dump that runs entirely in a phone's
// browser (engine + UI, no server). Used for quick testing on a phone.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const out = await build({
  stdin: { contents: "import './src/local/entry.ts'; import './web/app.js';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, write: false,
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await readFile('web/styles.css', 'utf8');
const html = `<title>Brain Dump</title>
<meta name="description" content="Get it out of your head. I'll help with the rest.">
<style>${css}</style>
<div id="app" class="app" aria-busy="true"><p class="boot">Loading…</p></div>
<div id="toasts" class="toasts" aria-live="polite"></div>
<script>${js}</script>
`;
await mkdir('dist-phone', { recursive: true });
await writeFile('dist-phone/brain-dump.html', html);
console.log(`dist-phone/brain-dump.html ${(html.length / 1024).toFixed(0)} KB`);
