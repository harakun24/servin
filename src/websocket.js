import crypto from 'node:crypto';
import { parseBytes, parseDuration } from './utils.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(data, isBinary = false) {
  const payload = isBinary
    ? Buffer.from(data)
    : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');

  const opcode = isBinary ? 0x82 : 0x81;
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = opcode;
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

export class WebSocketBroker {
  constructor() {
    this.topics = new Map();
    this.sessionSockets = new Map();
  }

  subscribe(topic, socket) {
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic).add(socket);
  }

  unsubscribe(topic, socket) {
    const set = this.topics.get(topic);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.topics.delete(topic);
    }
  }

  publish(topic, data, excludeSocket = null) {
    const set = this.topics.get(topic);
    if (!set) return;
    const isBinary = data instanceof Uint8Array;
    const frame = encodeFrame(data, isBinary);
    for (const client of set) {
      if (client !== excludeSocket && client.isOpen) {
        client.rawSocket.write(frame);
      }
    }
  }

  bindSession(sid, socket) {
    if (!sid) return;
    if (!this.sessionSockets.has(sid)) this.sessionSockets.set(sid, new Set());
    this.sessionSockets.get(sid).add(socket);
  }

  unbindSession(sid, socket) {
    if (!sid) return;
    const set = this.sessionSockets.get(sid);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.sessionSockets.delete(sid);
    }
  }

  kickSession(sid) {
    const set = this.sessionSockets.get(sid);
    if (!set) return;
    for (const client of [...set]) {
      client.close(4001, 'Session revoked');
    }
    this.sessionSockets.delete(sid);
  }
}

export function createLinearSocket(tcpSocket, headBuffer, broker, config = {}, sessionId = null) {
  const maxPayload = parseBytes(config.maxPayload || '1mb', 1024 ** 2);
  const heartbeatMs = config.heartbeat ? parseDuration(config.heartbeat, 0) : 0;
  const binaryMode = Boolean(config.binary);

  const joinedTopics = new Set();
  const messageQueue = [];
  let waitResolver = null;
  let closed = false;
  let alive = true;
  let recvBuffer = headBuffer && headBuffer.length > 0 ? Buffer.from(headBuffer) : Buffer.alloc(0);
  let fragmentedChunks = [];
  let fragmentedOpcode = 0;

  const wakeReader = () => {
    if (waitResolver) {
      const fn = waitResolver;
      waitResolver = null;
      fn();
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const topic of joinedTopics) {
      broker.unsubscribe(topic, sessionSocket);
    }
    joinedTopics.clear();
    if (sessionId) broker.unbindSession(sessionId, sessionSocket);
    wakeReader();
  };

  const sessionSocket = {
    rawSocket: tcpSocket,
    get isOpen() {
      return !closed && !tcpSocket.destroyed;
    },
    get bufferedAmount() {
      return tcpSocket.writableLength || 0;
    },
    join(topic) {
      joinedTopics.add(topic);
      broker.subscribe(topic, sessionSocket);
    },
    leave(topic) {
      joinedTopics.delete(topic);
      broker.unsubscribe(topic, sessionSocket);
    },
    broadcast(topic, data) {
      broker.publish(topic, data, sessionSocket);
    },
    send(data) {
      if (!sessionSocket.isOpen) return;
      const isBin = data instanceof Uint8Array || binaryMode;
      tcpSocket.write(encodeFrame(data, isBin));
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      if (!tcpSocket.destroyed) {
        const reasonBuf = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
        tcpSocket.write(encodeControlFrame(0x8, payload));
        tcpSocket.end();
      }
      cleanup();
    },
    async *[Symbol.asyncIterator]() {
      while (!closed || messageQueue.length > 0) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift();
        } else {
          await new Promise((resolve) => {
            waitResolver = resolve;
          });
        }
      }
    }
  };

  if (sessionId) broker.bindSession(sessionId, sessionSocket);

  let heartbeatTimer = null;
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (!alive) {
        sessionSocket.close(1001, 'Heartbeat timeout');
        return;
      }
      alive = false;
      if (sessionSocket.isOpen) {
        tcpSocket.write(encodeControlFrame(0x9));
      }
    }, heartbeatMs);
  }

  const deliverMessage = (opcode, payload) => {
    if (opcode === 0x2 || binaryMode) {
      messageQueue.push(new Uint8Array(payload));
    } else {
      const text = payload.toString('utf8');
      try {
        messageQueue.push(JSON.parse(text));
      } catch {
        messageQueue.push(text);
      }
    }
    wakeReader();
  };

  const processFrames = () => {
    while (recvBuffer.length >= 2 && !closed) {
      const b0 = recvBuffer[0];
      const b1 = recvBuffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (recvBuffer.length < 4) return;
        payloadLen = recvBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (recvBuffer.length < 10) return;
        payloadLen = Number(recvBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > maxPayload) {
        sessionSocket.close(1009, 'Payload exceeds maxPayload');
        return;
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (recvBuffer.length < totalFrameLen) return;

      let payload = recvBuffer.subarray(offset + maskLen, totalFrameLen);
      if (masked) {
        const maskKey = recvBuffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }

      recvBuffer = recvBuffer.subarray(totalFrameLen);
      alive = true;

      if (opcode === 0x8) {
        sessionSocket.close(1000, 'Client closed');
        return;
      }
      if (opcode === 0x9) {
        if (sessionSocket.isOpen) tcpSocket.write(encodeControlFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) {
        continue;
      }

      if (opcode === 0x0) {
        fragmentedChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragmentedChunks);
          fragmentedChunks = [];
          deliverMessage(fragmentedOpcode, full);
        }
      } else if (!fin) {
        fragmentedOpcode = opcode;
        fragmentedChunks = [payload];
      } else {
        deliverMessage(opcode, payload);
      }
    }
  };

  tcpSocket.on('data', (chunk) => {
    recvBuffer = Buffer.concat([recvBuffer, chunk]);
    processFrames();
  });

  tcpSocket.on('close', cleanup);
  tcpSocket.on('error', cleanup);

  processFrames();
  return sessionSocket;
}

export function performWsHandshake(req, tcpSocket, extraHeaders = new Headers()) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return false;

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`
  ];

  extraHeaders.forEach((val, name) => {
    lines.push(`${name}: ${val}`);
  });

  lines.push('', '');
  tcpSocket.write(lines.join('\r\n'));
  return true;
}