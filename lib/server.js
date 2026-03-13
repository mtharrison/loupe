'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { renderAppHtml } = require('./ui');

function createTraceServer(store, options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port) || 4319;
  const clients = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(res, renderAppHtml());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/traces') {
        sendJson(res, 200, store.list(parseFilters(url)));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/hierarchy') {
        sendJson(res, 200, store.hierarchy(parseFilters(url)));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        openSse(res, clients);
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/api/traces') {
        store.clear();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/traces/')) {
        const traceId = decodeURIComponent(url.pathname.slice('/api/traces/'.length));
        const trace = store.get(traceId);
        if (!trace) {
          sendJson(res, 404, { error: 'Trace not found' });
          return;
        }

        sendJson(res, 200, trace);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  store.on('event', (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });

      server.unref();

      return {
        host,
        port,
        url: `http://${host}:${port}`,
      };
    },
    close() {
      for (const client of clients) {
        client.end();
      }
      clients.clear();
      server.close();
    },
  };
}

function parseFilters(url) {
  return {
    search: url.searchParams.get('search') || undefined,
    status: url.searchParams.get('status') || undefined,
    kind: url.searchParams.get('kind') || undefined,
    provider: url.searchParams.get('provider') || undefined,
    model: url.searchParams.get('model') || undefined,
    groupBy: url.searchParams.get('groupBy') || undefined,
    tags: url.searchParams.getAll('tag').concat(url.searchParams.get('tags') || []).filter(Boolean),
  };
}

function sendHtml(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function openSse(res, clients) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
  });
  res.write('\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

module.exports = {
  createTraceServer,
};
