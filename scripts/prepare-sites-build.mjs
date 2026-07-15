import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const serverDir = join(dist, 'server');
const openAiDir = join(dist, '.openai');

mkdirSync(serverDir, { recursive: true });
mkdirSync(openAiDir, { recursive: true });
copyFileSync(join(root, '.openai', 'hosting.json'), join(openAiDir, 'hosting.json'));

writeFileSync(join(serverDir, 'index.js'), `
export default {
  async fetch(request, env) {
    const assets = env && env.ASSETS;
    if (!assets || typeof assets.fetch !== 'function') {
      return new Response('Language Reader Web assets are not available.', { status: 500 });
    }

    const response = await assets.fetch(request);
    if (response.status !== 404) return response;

    const url = new URL(request.url);
    url.pathname = '/index.html';
    url.search = '';
    return assets.fetch(new Request(url, request));
  }
};
`.trimStart());
