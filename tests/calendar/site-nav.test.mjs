// The site's menus, which every page repeats by hand. A page added or edited without one of these
// links fails here. Run with the other tests: node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pages = readdirSync(root).filter((f) => f.endsWith('.html')).sort();

test('every page links to the brother directory under Chapter, in the top menu and the phone menu', () => {
  assert.ok(pages.length >= 12, `found ${pages.length} pages`);
  for (const page of pages) {
    const html = readFileSync(join(root, page), 'utf8');

    const top = html.match(/<a href="[^"]*">Chapter &#9662;<\/a>\s*<ul class="nav-dropdown-menu">([\s\S]*?)<\/ul>/);
    assert.ok(top, `${page}: the Chapter dropdown in the top menu`);
    const topLinks = [...top[1].matchAll(/<li><a href="([^"]+)">([^<]+)<\/a><\/li>/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(topLinks.map((l) => l[0]), ['Executive Board', 'Meetings', 'Brother Directory'], `${page}: top menu`);
    assert.equal(topLinks[2][1], 'directory.html', `${page}: top menu`);

    const phone = html.match(/<div class="mobile-menu-links">([\s\S]*?)<\/div>/);
    assert.ok(phone, `${page}: the phone menu`);
    const links = [...phone[1].matchAll(/<a href="([^"]+)" class="mobile-nav-link( mobile-nav-sub)?[^"]*">([^<]+)<\/a>/g)].map((m) => ({ href: m[1], sub: !!m[2], label: m[3] }));
    const at = links.findIndex((l) => !l.sub && l.label === 'Chapter');
    assert.ok(at >= 0, `${page}: Chapter in the phone menu`);
    const under = [];
    for (let i = at + 1; i < links.length && links[i].sub; i += 1) under.push(links[i]);
    assert.deepEqual(under.map((l) => l.label), ['Executive Board', 'Meetings', 'Brother Directory'], `${page}: phone menu`);
    assert.equal(under[2].href, 'directory.html', `${page}: phone menu`);
  }
});
