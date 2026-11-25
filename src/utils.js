import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip'
};

const HTML_ESCAPE_MAP = {
  '&': '&',
  '<': '<',
  '>': '>',
  '"': '"',
  "\'": '\''
};
// test mark error

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

export class HtmlResponse {
  constructor(html) {
    this.html = String(html);
  }
}

export class FileStreamResponse {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }
}

export function parseDuration(input, fallbackMs = 0) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(input.trim());
  if (!match) return fallbackMs;
  const val = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(val * multipliers[unit]);
}

export function parseBytes(input, fallbackBytes = Infinity) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return fallbackBytes;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(input.trim());
  if (!match) return fallbackBytes;
  const val = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(val * multipliers[unit]);
}

export function applyFieldMask(data, fieldsParam) {
  if (!fieldsParam || data === null || typeof data !== 'object') return data;
  const paths = fieldsParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (paths.length === 0) return data;

  const tree = {};
  for (const p of paths) {
    const parts = p.split('.');
    let cur = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) cur[part] = true;
      else {
        if (cur[part] !== true) cur[part] = cur[part] || {};
        cur = cur[part];
      }
    }
  }

  function filterNode(val, mask) {
    if (mask === true || val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map((item) => filterNode(item, mask));
    const out = {};
    for (const key of Object.keys(mask)) {
      if (key in val) out[key] = filterNode(val[key], mask[key]);
    }
    return out;
  }

  return filterNode(data, tree);
}

export function applyRedaction(data, patterns = []) {
  if (!patterns || patterns.length === 0 || data === null || typeof data !== 'object') {
    return data;
  }

  const regexes = patterns.map((pat) => {
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
  });

  function isBlocked(keyPath, keyName) {
    return regexes.some((rx) => rx.test(keyName) || rx.test(keyPath));
  }

  function scrub(val, prefix = '') {
    if (val === null || typeof val !== 'object') return val;
    if (val instanceof Date || val instanceof Uint8Array) return val;
    if (Array.isArray(val)) return val.map((item) => scrub(item, prefix));
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const fullPath = prefix ? `${prefix}.${k}` : k;
      if (!isBlocked(fullPath, k)) {
        out[k] = scrub(v, fullPath);
      }
    }
    return out;
  }

  return scrub(data);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateExpect(payload, schema, basePath = '') {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return [{ field: basePath || 'body', message: 'Expected a JSON object' }];
  }

  for (const [key, rule] of Object.entries(schema)) {
    const fieldPath = basePath ? `${basePath}.${key}` : key;
    const val = payload[key];

    if (Array.isArray(rule)) {
      if (val === undefined || !rule.includes(val)) {
        errors.push({ field: fieldPath, message: `Must be one of: ${rule.join(', ')}` });
      }
      continue;
    }

    if (typeof rule === 'object' && rule !== null) {
      if (val === undefined || val === null) {
        errors.push({ field: fieldPath, message: 'Required object is missing' });
      } else {
        errors.push(...validateExpect(val, rule, fieldPath));
      }
      continue;
    }

    if (typeof rule === 'string') {
      const optional = rule.endsWith('?');
      const baseType = optional ? rule.slice(0, -1) : rule;

      if (val === undefined || val === null) {
        if (!optional) errors.push({ field: fieldPath, message: 'Field is required' });
        continue;
      }

      if (baseType === 'email') {
        if (typeof val !== 'string' || !EMAIL_RE.test(val)) {
          errors.push({ field: fieldPath, message: 'Must be a valid email address' });
        }
      } else if (baseType === 'array') {
        if (!Array.isArray(val)) {
          errors.push({ field: fieldPath, message: 'Must be an array' });
        }
      } else if (baseType === 'number') {
        if (typeof val !== 'number' || Number.isNaN(val)) {
          errors.push({ field: fieldPath, message: 'Must be a valid number' });
        }
      } else if (typeof val !== baseType) {
        errors.push({ field: fieldPath, message: `Must be of type ${baseType}` });
      }
    }
  }

  return errors;
}

export async function buildFileHttpResponse(descriptor, reqHeaders) {
  let stat;
  try {
    stat = await fsp.stat(descriptor.filePath);
  } catch {
    return Response.json({ error: 'File Not Found' }, { status: 404 });
  }

  if (!stat.isFile()) {
    return Response.json({ error: 'Not a file' }, { status: 404 });
  }

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (reqHeaders.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Accept-Ranges': 'bytes' }
    });
  }

  const ext = path.extname(descriptor.filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const rangeHeader = reqHeaders.get('range');

  if (rangeHeader && rangeHeader.startsWith('bytes=')) {
    const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
    const start = startStr ? parseInt(startStr, 10) : 0;
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${stat.size}` }
      });
    }

    const nodeStream = fs.createReadStream(descriptor.filePath, { start, end });
    return new Response(Readable.toWeb(nodeStream), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        ETag: etag
      }
    });
  }

  const nodeStream = fs.createReadStream(descriptor.filePath);
  return new Response(Readable.toWeb(nodeStream), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      ETag: etag
    }
  });
}

export async function* parseMultipartStream(webStream, contentType, opts = {}) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) {
    throw Object.assign(new Error('Invalid multipart/form-data boundary'), { status: 400 });
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2].trim();
  const firstDelimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const headerEndSep = Buffer.from('\r\n\r\n');
  const maxFileSize = parseBytes(opts.maxFileSize, Infinity);

  const reader = webStream.getReader();
  let buf = Buffer.alloc(0);
  let eof = false;

  async function pullMore() {
    if (eof) return false;
    const { done, value } = await reader.read();
    if (done) {
      eof = true;
      return false;
    }
    buf = Buffer.concat([buf, Buffer.from(value)]);
    return true;
  }

  while (buf.indexOf(firstDelimiter) === -1) {
    if (!(await pullMore())) return;
  }

  const startIdx = buf.indexOf(firstDelimiter) + firstDelimiter.length;
  buf = buf.subarray(startIdx);

  while (true) {
    while (buf.length < 4 && !eof) await pullMore();
    if (buf.subarray(0, 2).toString() === '--') break;
    if (buf.subarray(0, 2).toString() === '\r\n') buf = buf.subarray(2);

    while (buf.indexOf(headerEndSep) === -1) {
      if (!(await pullMore())) return;
    }

    const headerEndIdx = buf.indexOf(headerEndSep);
    const rawHeaders = buf.subarray(0, headerEndIdx).toString('utf8');
    buf = buf.subarray(headerEndIdx + 4);

    const dispMatch = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(rawHeaders);
    const nameMatch = dispMatch && /name="([^"]+)"/i.exec(dispMatch[1]);
    const fileMatch = dispMatch && /filename="([^"]*)"/i.exec(dispMatch[1]);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);

    const name = nameMatch ? nameMatch[1] : '';
    const filename = fileMatch ? fileMatch[1] : null;
    const partType = typeMatch ? typeMatch[1].trim() : 'text/plain';
    const isFile = filename !== null;

    let partDone = false;
    let bytesRead = 0;
    const guardLen = nextDelimiter.length + 4;

    const partStream = new ReadableStream({
      async pull(controller) {
        if (partDone) {
          controller.close();
          return;
        }

        while (true) {
          const delimIdx = buf.indexOf(nextDelimiter);
          if (delimIdx !== -1) {
            const chunk = buf.subarray(0, delimIdx);
            buf = buf.subarray(delimIdx + nextDelimiter.length);
            partDone = true;
            if (chunk.length > 0) {
              bytesRead += chunk.length;
              if (isFile && bytesRead > maxFileSize) {
                const err = Object.assign(new Error('File exceeds maxFileSize'), { status: 413 });
                controller.error(err);
                return;
              }
              controller.enqueue(new Uint8Array(chunk));
            }
            controller.close();
            return;
          }

          if (buf.length > guardLen) {
            const safeEnd = buf.length - guardLen;
            const chunk = buf.subarray(0, safeEnd);
            buf = buf.subarray(safeEnd);
            bytesRead += chunk.length;
            if (isFile && bytesRead > maxFileSize) {
              const err = Object.assign(new Error('File exceeds maxFileSize'), { status: 413 });
              controller.error(err);
              return;
            }
            controller.enqueue(new Uint8Array(chunk));
            return;
          }

          if (!(await pullMore())) {
            partDone = true;
            if (buf.length > 0) {
              controller.enqueue(new Uint8Array(buf));
              buf = Buffer.alloc(0);
            }
            controller.close();
            return;
          }
        }
      }
    });

    let consumed = false;
    const consumeBuffer = async () => {
      consumed = true;
      const r = partStream.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    };

    const trackedStream = new ReadableStream({
      async start(controller) {
        consumed = true;
        const r = partStream.getReader();
        try {
          while (true) {
            const { done, value } = await r.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      }
    });

    yield {
      name,
      filename,
      contentType: partType,
      isFile,
      isField: !isFile,
      stream: trackedStream,
      async text() {
        return (await consumeBuffer()).toString('utf8');
      },
      async json() {
        return JSON.parse((await consumeBuffer()).toString('utf8'));
      }
    };

    if (!consumed) {
      await consumeBuffer();
    }
  }
}

export function createLagMonitor(thresholdMs = 60) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    isOverloaded() {
      const p95Ms = histogram.percentile(95) / 1e6;
      histogram.reset();
      return p95Ms > thresholdMs;
    },
    stop() {
      histogram.disable();
    }
  };
}