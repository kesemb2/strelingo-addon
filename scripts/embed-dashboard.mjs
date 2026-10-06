// Embeds src/dashboard/page.html into src/dashboard/page.ts, so the page
// ships inside the server bundle (Vercel) with no file reads at runtime.
// Run after editing the HTML: npm run embed
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../src/dashboard/', import.meta.url);
const html = readFileSync(new URL('page.html', dir), 'utf8');
const out = `// Generated from page.html by scripts/embed-dashboard.mjs — edit the HTML, then run: npm run embed\n`
    + `export const PAGE_HTML: string = ${JSON.stringify(html)};\n`;
writeFileSync(new URL('page.ts', dir), out);
console.log(`page.ts: ${html.length} chars`);
