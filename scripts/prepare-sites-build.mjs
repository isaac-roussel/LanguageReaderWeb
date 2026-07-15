import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const client = join(dist, 'client');
const serverDir = join(dist, 'server');
const openAiDir = join(dist, '.openai');

mkdirSync(serverDir, { recursive: true });
mkdirSync(openAiDir, { recursive: true });
copyFileSync(join(root, '.openai', 'hosting.json'), join(openAiDir, 'hosting.json'));

let html = readFileSync(join(client, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, (_match, href) => {
  const css = readFileSync(join(client, href.replace(/^\//, '')), 'utf8');
  return `<style>${css}</style>`;
});
html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_match, src) => {
  const js = readFileSync(join(client, src.replace(/^\//, '')), 'utf8');
  return `<script type="module">${js}<\/script>`;
});

writeFileSync(join(serverDir, 'index.js'), `
const html = ${JSON.stringify(html)};

export default {
  async fetch() {
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  }
};
`.trimStart());
