// The activity page ships as a string inside the server (page.ts, generated
// from page.html): it must be up to date, and its script must parse.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_HTML } from '../src/dashboard/page.js';

const passed: string[] = [];
function check(name: string, fn: () => void) {
    fn();
    passed.push(`  ok  ${name}`);
}

check('page.ts matches page.html (run npm run embed after editing the HTML)', () => {
    const html = readFileSync(new URL('../src/dashboard/page.html', import.meta.url), 'utf8');
    assert.equal(PAGE_HTML, html);
});

check('the page script parses and reads its settings from one placeholder', () => {
    const scripts = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.equal(scripts.length, 1);
    assert.equal(PAGE_HTML.split('__STRELINGO_BOOT__').length, 2);
    const boot = JSON.stringify({ apiBase: '', configureUrl: '/configure', scope: 'all', languages: {} });
    // Parse only (new Function compiles without running).
    new Function(scripts[0].replace('__STRELINGO_BOOT__', boot));
});

check('third-party text is never put in as HTML', () => {
    assert.doesNotMatch(PAGE_HTML, /innerHTML|insertAdjacentHTML|document\.write/);
});

console.log(passed.join('\n'));
console.log(`dashboard: ${passed.length} passed`);
