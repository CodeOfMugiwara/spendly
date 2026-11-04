/*
 * Tiny zero-dependency static server for local testing.
 *
 *   npm start                → http://localhost:4173
 *   PORT=8080 npm start      → http://localhost:8080
 *
 * The service worker is allowed on localhost, so this server is enough to test
 * the offline behaviour without deploying.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

export function createStaticServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      const filePath = path.resolve(ROOT, `.${pathname}`);
      if (!filePath.startsWith(ROOT + path.sep)) {
        response.writeHead(403).end('Forbidden');
        return;
      }

      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Server error');
      console.error(error);
    }
  });
}

export function startServer(port = 4173) {
  return new Promise((resolve, reject) => {
    const server = createStaticServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 4173;
  const server = await startServer(port);
  const address = server.address();
  console.log(`Spendly test server → http://localhost:${address.port}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
