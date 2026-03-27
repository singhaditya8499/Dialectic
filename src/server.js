import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDebate } from './debateEngine.js';
import { getProviderDefaults } from './providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const STORAGE_DIR = path.resolve(__dirname, '../storage/debates');

loadEnvFile(path.resolve(__dirname, '../.env'));
ensureStorageDir();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
      });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        time: new Date().toISOString()
      });
    }

    if (requestUrl.pathname === '/api/providers' && req.method === 'GET') {
      return sendJson(res, 200, getProviderDefaults());
    }

    if (requestUrl.pathname === '/api/debate' && req.method === 'POST') {
      const body = await readJsonBody(req, 1_000_000);
      const result = await runDebate(body);
      const savedDebate = body.saveDebate ? saveDebateRecord(body, result) : null;

      return sendJson(res, 200, {
        ...result,
        savedDebate
      });
    }

    if (requestUrl.pathname === '/api/debate/stream' && req.method === 'POST') {
      return await handleDebateStream(req, res);
    }

    if (requestUrl.pathname === '/api/debates' && req.method === 'GET') {
      return sendJson(res, 200, {
        debates: listStoredDebates()
      });
    }

    const debateFileMatch = requestUrl.pathname.match(/^\/api\/debates\/([A-Za-z0-9._-]+)$/);
    if (debateFileMatch && req.method === 'GET') {
      const debateId = debateFileMatch[1];
      const record = loadStoredDebate(debateId);
      if (!record) {
        return sendJson(res, 404, { error: 'Debate not found.' });
      }

      return sendJson(res, 200, record);
    }

    if (req.method === 'GET') {
      return serveStaticAsset(requestUrl.pathname, res);
    }

    return sendJson(res, 404, {
      error: 'Not found'
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error.message || 'Unexpected server error'
    });
  }
});

server.listen(port, host, () => {
  console.log(`Dialectic app running at http://${host}:${port}`);
});

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error('Request body too large.');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

async function handleDebateStream(req, res) {
  const body = await readJsonBody(req, 1_000_000);
  const sendEvent = beginSse(res);

  let connectionClosed = false;
  req.on('close', () => {
    connectionClosed = true;
  });

  const safeSend = (eventName, payload) => {
    if (connectionClosed || res.writableEnded) {
      return;
    }

    sendEvent(eventName, payload);
  };

  try {
    const result = await runDebate(body, {
      onStart: async (payload) => {
        safeSend('start', payload);
      },
      onThinking: async (payload) => {
        safeSend('thinking', payload);
      },
      onTurn: async (payload) => {
        safeSend('turn', payload);
      },
      onSummaryThinking: async (payload) => {
        safeSend('summary_thinking', payload);
      },
      onSummary: async (payload) => {
        safeSend('summary', payload);
      }
    });

    const savedDebate = body.saveDebate ? saveDebateRecord(body, result) : null;
    safeSend('complete', {
      result,
      savedDebate
    });
  } catch (error) {
    safeSend('error', {
      error: error.message || 'Unexpected stream error'
    });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

function beginSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });

  res.write(': connected\n\n');

  return (eventName, payload) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function serveStaticAsset(pathname, res) {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(normalizedPath).replace(/^([.]{2}[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, 404, { error: 'Asset not found' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypeForExtension(ext);

  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  stream.pipe(res);
}

function mimeTypeForExtension(ext) {
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function ensureStorageDir() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

function saveDebateRecord(requestBody, result) {
  ensureStorageDir();

  const question = result?.meta?.question || requestBody?.question || 'debate';
  const id = makeDebateId(question);
  const createdAt = new Date().toISOString();
  const debate = {
    meta: result?.meta || null,
    transcript: Array.isArray(result?.transcript) ? result.transcript : [],
    summary: typeof result?.summary === 'string' ? result.summary : '',
    summaryError: result?.summaryError || null
  };

  const record = {
    id,
    createdAt,
    request: sanitizeRequestForStorage(requestBody),
    result,
    debate
  };

  const filePath = path.join(STORAGE_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');

  return {
    id,
    createdAt,
    filePath
  };
}

function listStoredDebates() {
  ensureStorageDir();

  const files = fs
    .readdirSync(STORAGE_DIR)
    .filter((name) => name.endsWith('.json'));

  const debates = [];

  for (const fileName of files) {
    try {
      const filePath = path.join(STORAGE_DIR, fileName);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const result = extractStoredResult(parsed);
      const summary = typeof result?.summary === 'string' ? result.summary : '';
      const transcript = Array.isArray(result?.transcript) ? result.transcript : [];

      debates.push({
        id: parsed.id || fileName.replace(/\.json$/, ''),
        createdAt: parsed.createdAt || null,
        question: result?.meta?.question || parsed?.request?.question || 'Untitled debate',
        debateType: result?.meta?.debateType || parsed?.request?.debateType || 'motion',
        roundsCompleted: Number(result?.meta?.roundsCompleted || 0),
        stopReason: result?.meta?.stopReason || 'unknown',
        turnCount: transcript.length,
        summaryExcerpt: summary ? summary.slice(0, 220) : ''
      });
    } catch {
      // Ignore unreadable files and continue listing the rest.
    }
  }

  return debates.sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '') || 0;
    const bTime = Date.parse(b.createdAt || '') || 0;
    return bTime - aTime;
  });
}

function loadStoredDebate(id) {
  if (!isValidDebateId(id)) {
    throw new Error('Invalid debate id.');
  }

  const filePath = path.join(STORAGE_DIR, `${id}.json`);
  if (!filePath.startsWith(STORAGE_DIR) || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('Stored debate could not be parsed.');
  }
}

function extractStoredResult(record) {
  if (record?.result && typeof record.result === 'object') {
    return record.result;
  }

  if (record?.debate && typeof record.debate === 'object') {
    return record.debate;
  }

  return null;
}

function sanitizeRequestForStorage(body) {
  return {
    debateType: body?.debateType === 'choice' ? 'choice' : 'motion',
    question: typeof body?.question === 'string' ? body.question.trim() : '',
    optionA: typeof body?.optionA === 'string' ? body.optionA.trim() : null,
    optionB: typeof body?.optionB === 'string' ? body.optionB.trim() : null,
    maxRounds: Number.isFinite(Number(body?.maxRounds)) ? Number(body.maxRounds) : null,
    skipSummary: Boolean(body?.skipSummary),
    useSeparateSummaryModel: Boolean(body?.useSeparateSummaryModel),
    forModel: sanitizeModelConfig(body?.forModel),
    againstModel: sanitizeModelConfig(body?.againstModel),
    summaryModel: sanitizeModelConfig(body?.summaryModel)
  };
}

function sanitizeModelConfig(config) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  const cleaned = {
    provider: typeof config.provider === 'string' ? config.provider : '',
    model: typeof config.model === 'string' ? config.model : ''
  };

  if (typeof config.baseUrl === 'string' && config.baseUrl.trim()) {
    cleaned.baseUrl = config.baseUrl.trim();
  }

  return cleaned;
}

function makeDebateId(question) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'debate';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${slug}-${suffix}`;
}

function isValidDebateId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}
