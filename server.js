const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = process.env.MODEL_NAME || 'claude-sonnet-4-20250514';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ROOT = __dirname;
const LIMIT_WINDOW_MS = 60 * 1000;
const LIMIT_MAX = 30;
const BODY_LIMIT_BYTES = 1024 * 1024;

const rateBucket = new Map();

function now() { return Date.now(); }

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(body);
}

function sendFile(res, filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8'
    };
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'content-type': types[ext] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

function withinRoot(resolvedPath) {
  return resolvedPath.startsWith(ROOT);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });

    req.on('error', () => reject(new Error('request_error')));
  });
}

function validPayload(body) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.system !== 'string' || body.system.length < 20 || body.system.length > 4000) return false;
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 20) return false;
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object') return false;
    if (!['user', 'assistant'].includes(msg.role)) return false;
    if (typeof msg.content !== 'string' || msg.content.length < 1 || msg.content.length > 12000) return false;
  }
  return true;
}

function checkRate(ip) {
  const t = now();
  const rec = rateBucket.get(ip) || { resetAt: t + LIMIT_WINDOW_MS, count: 0 };
  if (t > rec.resetAt) {
    rec.resetAt = t + LIMIT_WINDOW_MS;
    rec.count = 0;
  }
  rec.count += 1;
  rateBucket.set(ip, rec);
  return rec.count <= LIMIT_MAX;
}

async function handleMentor(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRate(ip)) {
    return json(res, 429, { error: 'Rate limit exceeded. Please wait before sending more messages.' });
  }

  if (!API_KEY) {
    return json(res, 500, { error: 'Server missing ANTHROPIC_API_KEY. Add it to environment first.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    if (error.message === 'body_too_large') return json(res, 413, { error: 'Payload too large' });
    return json(res, 400, { error: 'Invalid JSON payload' });
  }

  if (!validPayload(body)) {
    return json(res, 400, { error: 'Invalid request payload' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        max_tokens: 1000,
        system: body.system,
        messages: body.messages
      })
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return json(res, upstream.status, {
        error: data?.error?.message || 'Anthropic API request failed',
        type: data?.error?.type || 'upstream_error'
      });
    }

    const reply = data?.content?.[0]?.text;
    if (!reply) return json(res, 502, { error: 'Upstream returned an empty response.' });

    return json(res, 200, { content: [{ text: reply }] });
  } catch (error) {
    return json(res, 502, { error: 'Gateway failed to reach AI provider.', detail: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      status: API_KEY ? 'ok' : 'degraded',
      model: '/api/mentor',
      security: API_KEY ? 'API key loaded server-side' : 'Missing ANTHROPIC_API_KEY',
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/mentor') {
    return handleMentor(req, res);
  }

  if (req.method === 'GET') {
    let reqPath = decodeURIComponent(url.pathname);
    if (reqPath === '/') reqPath = '/index.html';

    let fullPath = path.resolve(ROOT, `.${reqPath}`);
    if (!withinRoot(fullPath)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }

    if (!fs.existsSync(fullPath)) {
      fullPath = path.resolve(ROOT, 'index.html');
    }

    return sendFile(res, fullPath);
  }

  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`AI Founder OS running on http://localhost:${PORT}`);
});
