import crypto from 'node:crypto';
import { parseBytes, parseDuration } from './utils.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createRingBuffer(capacity = 100) {
  const cap = Math.max(1, capacity);
  const items = new Array(cap);
  let start = 0;
  let size = 0;

  return {
    push(entry) {
      const idx = (start + size) % cap;
      items[idx] = entry;
      if (size === cap) {
        start = (start + 1) % cap;
      } else {
        size += 1;
      }
    },
    getSince(afterSeq) {
      if (afterSeq <= 0) return [];
      if (size === 0) return null;
      const oldestSeq = items[start].seq;
      const newestSeq = items[(start + size - 1) % cap].seq;
      if (afterSeq < oldestSeq - 1 || afterSeq > newestSeq) {
        return null;
      }
      const out = [];
      for (let i = 0; i < size; i += 1) {
        const item = items[(start + i) % cap];
        if (item.seq > afterSeq) out.push(item);
      }
      return out;
    }
  };
}

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

function setExclusiveRoom(socket, targetRoom) {
  if (!targetRoom) return;
  for (const joined of [...socket.rooms]) {
    if (joined !== targetRoom) {
      socket.leave(joined);
    }
  }
  if (!socket.rooms.has(targetRoom)) {
    socket.join(targetRoom);
  }
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

  publishAll(data, excludeSocket = null, maxBufferedBytes = 0) {
    const isBinary = data instanceof Uint8Array;
    const envelope = isBinary
      ? data
      : { type: 'broadcast', global: true, payload: data };
    const frame = encodeFrame(envelope, isBinary);
    const sentTo = new Set();

    for (const set of this.topics.values()) {
      for (const client of set) {
        if (sentTo.has(client)) continue;
        sentTo.add(client);
        if (client === excludeSocket || !client.isOpen) continue;
        if (maxBufferedBytes && client.bufferedAmount > maxBufferedBytes) {
          client.close(1008, 'Backpressure limit exceeded');
          continue;
        }
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
  if (typeof tcpSocket.setNoDelay === 'function') {
    tcpSocket.setNoDelay(true);
  }

  const maxPayload = typeof config.maxPayloadBytes === 'number'
    ? config.maxPayloadBytes
    : parseBytes(config.maxPayload || '1mb', 1024 ** 2);
  const maxEventsPerSec = config.maxEventsPerSec ?? 0;
  const maxBufferedBytes = typeof config.maxBufferedBytes === 'number'
    ? config.maxBufferedBytes
    : parseBytes(config.maxBuffered || '1mb', 1024 ** 2);
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
  let rateWindowStart = Date.now();
  let rateCount = 0;

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
    state: {},
    rooms: joinedTopics,
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
    broadcast(topicOrData, maybeData, opts = {}) {
      if (typeof topicOrData === 'string') {
        const topic = topicOrData;
        const data = maybeData;
        const options = (opts && typeof opts === 'object') ? opts : {};
        const set = broker.topics.get(topic);
        if (!set || set.size === 0) return;

        const isBinary = data instanceof Uint8Array;
        const envelope = isBinary
          ? data
          : { type: 'broadcast', room: topic, global: false, payload: data };
        const frame = encodeFrame(envelope, isBinary);
        const exclude = options.except ?? null;

        for (const client of set) {
          if (client === exclude || closed || client.rawSocket.destroyed) continue;
          if (maxBufferedBytes && (client.rawSocket.writableLength || 0) > maxBufferedBytes) {
            client.close(1008, 'Backpressure limit exceeded');
            continue;
          }
          client.rawSocket.write(frame);
        }
        return;
      }

      const data = topicOrData;
      const options = (maybeData && typeof maybeData === 'object') ? maybeData : {};
      const exclude = options.except ?? null;
      broker.publishAll(data, exclude, maxBufferedBytes);
    },
    to(topic) {
      return {
        broadcast(data, opts = {}) {
          sessionSocket.broadcast(topic, data, opts);
        }
      };
    },
    send(data) {
      if (closed || tcpSocket.destroyed) return false;
      if (maxBufferedBytes && (tcpSocket.writableLength || 0) > maxBufferedBytes) {
        sessionSocket.close(1008, 'Backpressure limit exceeded');
        return false;
      }
      const isBin = data instanceof Uint8Array || binaryMode;
      tcpSocket.write(encodeFrame(data, isBin));
      return true;
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
      if (!closed && !tcpSocket.destroyed) {
        tcpSocket.write(encodeControlFrame(0x9));
      }
    }, heartbeatMs);
  }

  const deliverMessage = (opcode, payload) => {
    if (maxEventsPerSec > 0) {
      const now = Date.now();
      if (now - rateWindowStart >= 1000) {
        rateWindowStart = now;
        rateCount = 0;
      }
      rateCount += 1;
      if (rateCount > maxEventsPerSec) {
        sessionSocket.send({ type: 'error', message: 'RATE_LIMIT_EXCEEDED' });
        return;
      }
    }

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
        if (!closed && !tcpSocket.destroyed) tcpSocket.write(encodeControlFrame(0xa, payload));
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

export function createDeclarativeWsRuntime(broker, routeConfig = {}) {
  const activeSockets = new Set();
  const roomStates = new Map();
  const bufferSize = routeConfig.sync?.bufferSize ?? 100;

  function ensureRoomState(roomName, initialState = {}) {
    if (!roomStates.has(roomName)) {
      roomStates.set(roomName, {
        state: structuredClone(initialState),
        seq: 0,
        ring: createRingBuffer(bufferSize)
      });
    }
    return roomStates.get(roomName);
  }

  function sendSnapshot(socket, roomName) {
    const entry = roomStates.get(roomName);
    if (!entry || !socket.isOpen) return;
    socket.send({
      type: 'sync_snapshot',
      room: roomName,
      seq: entry.seq,
      state: entry.state
    });
  }

  function commit(roomName, meta, mutator, initialState = {}) {
    const entry = ensureRoomState(roomName, initialState);
    mutator(entry.state);
    entry.seq += 1;

    entry.ring.push({
      seq: entry.seq,
      meta: meta ?? null,
      state: structuredClone(entry.state)
    });

    const members = broker.topics.get(roomName);
    if (!members) return entry.seq;

    for (const peer of members) {
      if (peer.isOpen) {
        peer.send({
          type: 'sync_patch',
          room: roomName,
          seq: entry.seq,
          meta: meta ?? null,
          state: entry.state
        });
      }
    }
    return entry.seq;
  }

  function createSocketsCollection(excludeSocket = null) {
    return {
      where(predicate) {
        const matched = [];
        for (const s of activeSockets) {
          if (!s.isOpen) continue;
          if (excludeSocket && s === excludeSocket) continue;
          if (!predicate || predicate(s)) matched.push(s);
        }
        return {
          sockets: matched,
          count: matched.length,
          send(data) {
            for (const s of matched) {
              s.send({ type: 'event', payload: data });
            }
          }
        };
      }
    };
  }

  return async function runDeclarativeSocket(socket, reqInfo = {}) {
    activeSockets.add(socket);
    const connData = reqInfo.data || {};
    const clientLastSeq = Number(reqInfo.lastSeq || 0);

    if (connData.room && !socket.state.room) {
      socket.state.room = String(connData.room);
    }

    const resolveRoom = (explicitRoom) =>
      explicitRoom || socket.state?.room || connData.room || 'default';

    const activeRoom = resolveRoom();
    if (activeRoom) {
      socket.state.room = activeRoom;
      setExclusiveRoom(socket, activeRoom);
    }

    if (typeof routeConfig.open === 'function') {
      await routeConfig.open(socket, reqInfo);
    }

    const postOpenRoom = resolveRoom();
    if (postOpenRoom) {
      socket.state.room = postOpenRoom;
      setExclusiveRoom(socket, postOpenRoom);
    }

    if (typeof routeConfig.state === 'function') {
      const initState = await routeConfig.state(socket, reqInfo);
      const entry = ensureRoomState(postOpenRoom, initState || {});

      if (clientLastSeq > 0) {
        const missed = entry.ring.getSince(clientLastSeq);
        if (Array.isArray(missed)) {
          for (const item of missed) {
            socket.send({
              type: 'sync_patch',
              room: postOpenRoom,
              seq: item.seq,
              meta: item.meta,
              state: item.state,
              replayed: true
            });
          }
        } else {
          sendSnapshot(socket, postOpenRoom);
        }
      } else {
        sendSnapshot(socket, postOpenRoom);
      }
    }

    const helpers = {
      commit,
      sockets: createSocketsCollection(socket),
      resync(roomName) {
        const target = resolveRoom(roomName);
        if (target) {
          socket.state.room = target;
          setExclusiveRoom(socket, target);
        }
        sendSnapshot(socket, target);
      }
    };

    try {
      for await (const msg of socket) {
        if (!msg || typeof msg !== 'object') continue;

        if (msg.type === 'resync') {
          const target = resolveRoom(msg.room);
          if (target) {
            socket.state.room = target;
            setExclusiveRoom(socket, target);
          }
          sendSnapshot(socket, target);
          continue;
        }

        if (msg.type === 'action' && routeConfig.actions && routeConfig.actions[msg.name]) {
          const actionDef = routeConfig.actions[msg.name];
          try {
            if (typeof actionDef === 'function') {
              await actionDef(msg.payload, socket, helpers);
            } else if (actionDef && typeof actionDef.run === 'function') {
              const validPayload = typeof actionDef.validate === 'function'
                ? await actionDef.validate(msg.payload, socket)
                : msg.payload;
              await actionDef.run(validPayload, socket, helpers);
            }
            const nextRoom = resolveRoom();
            if (nextRoom) {
              socket.state.room = nextRoom;
              setExclusiveRoom(socket, nextRoom);
            }
          } catch (err) {
            socket.send({
              type: 'error',
              action: msg.name,
              message: err?.message || 'Action failed'
            });
          }
        }
      }
    } finally {
      activeSockets.delete(socket);
      if (typeof routeConfig.close === 'function') {
        await routeConfig.close(socket, reqInfo);
      }
    }
  };
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