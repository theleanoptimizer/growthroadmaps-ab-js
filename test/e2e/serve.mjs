import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../../dist');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const PORT = parseInt(process.env.SDK_E2E_PORT || '4173', 10);

const MIME = {
  '.js': 'application/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.json': 'application/json',
};

function tryRead(dirs, urlPath) {
  for (const dir of dirs) {
    const candidate = path.join(dir, urlPath);
    if (!candidate.startsWith(dir)) continue;
    try {
      return { data: fs.readFileSync(candidate), ext: path.extname(candidate) };
    } catch { /* try next */ }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const lookup = urlPath === '/' ? '/index.html' : urlPath;

  const found = tryRead([DIST_DIR, FIXTURES_DIR], lookup);
  if (!found) {
    res.writeHead(404);
    res.end('Not found: ' + urlPath);
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[found.ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(found.data);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sdk-e2e] Static dist server listening on http://127.0.0.1:${PORT}`);
});
