import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { renderAppHtml } from './ui';
import { type TraceEvent, type TraceFilters, type TraceServer, type UIReloadEvent } from './types';
import { TraceStore } from './store';

export function createTraceServer(store: TraceStore, options: { allowPortFallback?: boolean; host?: string; port?: number } = {}): TraceServer {
  const host = options.host || '127.0.0.1';
  const requestedPort = toPortNumber(options.port, 4319);
  let activePort = requestedPort;
  const clients = new Set<ServerResponse>();

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${activePort}`}`);

      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(res, renderAppHtml());
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        await sendAsset(res, url.pathname);
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
    } catch (error: any) {
      sendJson(res, 500, { error: error.message });
    }
  });

  store.on('event', (event) => {
    broadcast(event);
  });

  return {
    async start() {
      await listenWithFallback(server, host, requestedPort, options.allowPortFallback);
      activePort = getBoundPort(server, requestedPort);

      server.unref();

      return {
        host,
        port: activePort,
        url: `http://${host}:${activePort}`,
      };
    },
    broadcast,
    close() {
      for (const client of clients) {
        client.end();
      }
      clients.clear();
      server.close();
    },
  };

  function broadcast(event: TraceEvent | UIReloadEvent) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  }
}

async function listenWithFallback(server: Server, host: string, port: number, allowPortFallback = false) {
  await new Promise<void>((resolve, reject) => {
    const tryListen = (nextPort: number, canFallback: boolean) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);

        if (canFallback && error?.code === 'EADDRINUSE') {
          tryListen(0, false);
          return;
        }

        reject(error);
      };

      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(nextPort, host);
    };

    tryListen(port, allowPortFallback);
  });
}

function getBoundPort(server: Server, fallbackPort: number): number {
  const address = server.address();
  if (address && typeof address === 'object' && typeof address.port === 'number') {
    return address.port;
  }

  return fallbackPort;
}

function toPortNumber(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

function parseFilters(url: URL): TraceFilters {
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

function sendHtml(res: ServerResponse, body: string) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function openSse(res: ServerResponse, clients: Set<ServerResponse>) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
  });
  res.write('\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

async function sendAsset(res: ServerResponse, pathname: string) {
  const assetName = pathname.replace(/^\/assets\//, '');
  const filePath = path.join(__dirname, 'client', assetName);

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Asset not found' });
  }
}

function getContentType(filePath: string): string {
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }

  if (filePath.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }

  if (filePath.endsWith('.svg')) {
    return 'image/svg+xml';
  }

  return 'application/octet-stream';
}
