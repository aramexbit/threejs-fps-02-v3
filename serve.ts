// serve.ts — tiny static server for local playtesting of FROSTLINE.
// Serves game/ on http://localhost:8080. Node 22 stdlib only; not part of
// the graded entry (the grader only runs main.ts).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'game');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    const path = pathname === '/' ? '/index.html' : pathname;
    const file = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
server.listen(process.env.PORT || 8080, () => console.log('FROSTLINE at http://localhost:8080'));
