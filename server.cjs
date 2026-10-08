'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadGameRules } = require('./game-rules.cjs');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COMMAND_FIELDS = {
  class: ['classKey'], preferences: ['questionMode'], ready: ['ready'],
  attribute: ['key', 'count'], rest: ['choice'], buy: ['itemId'],
  'use-item': ['itemId'], 'claim-quest': ['questId'], craft: ['recipeId'],
  equip: ['slot', 'gearId'], vote: ['journeyId', 'optionId'],
  'event-answer': ['journeyId', 'quizId', 'answer'], start: [], leave: [],
  action: ['type', 'skillId', 'targetId', 'allyId', 'battleId', 'turnNumber', 'quizId', 'answer', 'itemId'],
};

const clone = value => JSON.parse(JSON.stringify(value));
const hashToken = token => createHash('sha256').update(token.toLowerCase()).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function checkedObject(value, fields) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new ApiError(400, 'Ongeldige aanvraag.');
  }
  return value;
}

function checkedToken(value, label = 'sessie') {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new ApiError(400, 'Ongeldige ' + label + '.');
  return value.toLowerCase();
}

function checkedName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 24 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, 'Kies een naam van 1 tot 24 tekens.');
  }
  return value.trim();
}

function checkedRequestId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new ApiError(400, 'Ongeldige aanvraag-ID.');
  return value.toLowerCase();
}

function checkedPayload(command, value) {
  if (typeof command !== 'string' || !Object.hasOwn(COMMAND_FIELDS, command)) throw new ApiError(400, 'Onbekende actie.');
  const payload = checkedObject(value ?? {}, COMMAND_FIELDS[command]);
  for (const [key, entry] of Object.entries(payload)) {
    if (key === 'ready') {
      if (typeof entry !== 'boolean') throw new ApiError(400, 'Ongeldige gereedmelding.');
    } else if (['count', 'answer', 'turnNumber'].includes(key)) {
      if (!Number.isSafeInteger(entry)) throw new ApiError(400, 'Ongeldig getal.');
    } else if (entry !== null && (typeof entry !== 'string' || entry.length > 100)) {
      throw new ApiError(400, 'Ongeldige actiegegevens.');
    } else if (entry === null && !['gearId', 'targetId', 'allyId'].includes(key)) {
      throw new ApiError(400, 'Ongeldige actiegegevens.');
    }
  }
  if (command === 'action' && !['attack', 'skill', 'defend', 'item'].includes(payload.type)) {
    throw new ApiError(400, 'Ongeldige gevechtsactie.');
  }
  return payload;
}

// This store and its test helpers are never exposed over HTTP.
function openStore(dataDir, now) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'cellular-legends.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS squads (code TEXT PRIMARY KEY, record TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (
      code TEXT NOT NULL REFERENCES squads(code) ON DELETE CASCADE,
      member_hash TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (code, member_hash, request_id)
    );
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS receipt_age ON receipts(created_at);
  `);
  const getRow = db.prepare('SELECT record FROM squads WHERE code=?');
  const saveRow = db.prepare('INSERT INTO squads(code, record, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET record=excluded.record, updated_at=excluded.updated_at');
  const getReceipt = db.prepare('SELECT fingerprint, kind FROM receipts WHERE code=? AND member_hash=? AND request_id=?');
  const addReceipt = db.prepare('INSERT INTO receipts(code, member_hash, request_id, fingerprint, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  let secret = db.prepare("SELECT value FROM metadata WHERE key='invite-key'").get()?.value;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    db.prepare("INSERT INTO metadata(key,value) VALUES ('invite-key',?)").run(secret);
  }
  const store = {
    get(code) { const row = getRow.get(code); return row ? JSON.parse(row.record) : null; },
    codes() { return db.prepare('SELECT code FROM squads').all().map(row => row.code); },
    save(record, receipt) {
      db.exec('BEGIN IMMEDIATE');
      try {
        saveRow.run(record.state.code, JSON.stringify(record), now());
        if (receipt) addReceipt.run(record.state.code, receipt.memberHash, receipt.requestId, receipt.fingerprint, receipt.kind, now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    receipt(code, memberHash, requestId) { return getReceipt.get(code, memberHash, requestId) || null; },
    touch(code) {
      db.prepare('UPDATE squads SET updated_at=? WHERE code=? AND updated_at<?').run(now(), code, now() - 300000);
    },
    prune(before) {
      const expired = db.prepare('SELECT code FROM squads WHERE updated_at<?').all(before).map(row => row.code);
      db.prepare('DELETE FROM squads WHERE updated_at<?').run(before);
      return expired;
    },
    prunePrivate(before) {
      db.prepare('DELETE FROM receipts WHERE created_at<?').run(before);
      for (const code of store.codes()) {
        const record = store.get(code);
        let changed = false;
        for (const [memberHash, session] of Object.entries(record.sessions)) {
          if (session.left && session.departedAt < before) {
            delete record.sessions[memberHash]; changed = true;
          }
        }
        for (const [inviteHash, invite] of Object.entries(record.invites)) {
          if (invite.expiresAt <= now()) { delete record.invites[inviteHash]; changed = true; }
        }
        // Private housekeeping must not renew an abandoned squad's lifetime.
        if (changed) db.prepare('UPDATE squads SET record=? WHERE code=?').run(JSON.stringify(record), code);
      }
    },
    update(code, updater) {
      const record = store.get(code);
      if (!record) throw new Error('Squad bestaat niet.');
      updater(record);
      store.save(record);
      return clone(record);
    },
    inviteToken(code, memberHash, requestId) {
      return createHmac('sha256', Buffer.from(secret, 'hex')).update(code + ':' + memberHash + ':' + requestId).digest('hex');
    },
    close() { db.close(); },
  };
  return store;
}

function createGameServer(options = {}) {
  const now = options.now || Date.now;
  const rootDir = options.rootDir || __dirname;
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(rootDir, '.data');
  const port = options.port ?? Number(process.env.PORT || 3000);
  const host = options.host || '0.0.0.0';
  const rules = loadGameRules({ htmlPath: path.join(rootDir, 'index.html'), now });
  const store = openStore(dataDir, now);
  const activeCodes = new Set();
  const createdSquads = new Map();
  const buckets = new Map();
  const squadTtlMs = options.squadTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  let nextPrune = 0;
  let closed = false;
  let timer;
  let closing;
  const origins = new Set((options.corsOrigins || (process.env.PUBLIC_GAME_ORIGIN || '').split(','))
    .filter(Boolean).map(origin => new URL(origin).origin));

  // Persist migrations and expired turns before accepting a player's next command.
  function fresh(code) {
    const record = store.get(code);
    if (!record || record.closed) throw new ApiError(404, 'Deze squad bestaat niet meer.');
    const engine = new rules.SquadEngine(record.state);
    const changed = engine.tick(now());
    if (changed || engine.migrated) store.save(record);
    if (record.state.status === 'battle') activeCodes.add(code); else activeCodes.delete(code);
    return record;
  }

  for (const code of store.codes()) {
    const record = store.get(code);
    if (!record.closed && record.state.status === 'battle') activeCodes.add(code);
    if (!record.closed && record.creationHash) createdSquads.set(record.creationHash, code);
  }

  function limit(key, maximum, windowMs = 60000) {
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket || time >= bucket.until) {
      bucket = { count: 0, until: time + windowMs };
      buckets.set(key, bucket);
    }
    if (++bucket.count > maximum) throw new ApiError(429, 'Te veel aanvragen. Wacht even en probeer opnieuw.');
  }

  function auth(req, record, allowLeft = false) {
    const match = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
    if (!match) throw new ApiError(401, 'Je sessie ontbreekt. Open de squad opnieuw.');
    const memberHash = hashToken(match[1]);
    const session = record.sessions[memberHash];
    if (!session || (!allowLeft && (session.left || !Object.hasOwn(record.state.members, session.playerId)))) {
      throw new ApiError(403, 'Je hoort niet bij deze squad.');
    }
    limit('member:' + memberHash, 180);
    return { memberHash, playerId: session.playerId, left: session.left };
  }

  function envelope(record, playerId, extra = {}) {
    return { state: record.state, playerId, host: record.state.hostId === playerId, serverTime: now(), ...extra };
  }

  function receiptInfo(record, member, requestId, kind, payload) {
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind, payload })).digest('hex');
    const old = store.receipt(record.state.code, member.memberHash, requestId);
    if (old && old.fingerprint !== fingerprint) throw new ApiError(409, 'Deze aanvraag-ID is al voor een andere actie gebruikt.');
    return { old, receipt: { memberHash: member.memberHash, requestId, fingerprint, kind } };
  }

  async function readBody(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'Stuur de aanvraag als JSON.');
    if (Number(req.headers['content-length'] || 0) > 8192) throw new ApiError(413, 'De aanvraag is te groot.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new ApiError(413, 'De aanvraag is te groot.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ApiError(400, 'De JSON-aanvraag is ongeldig.'); }
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'OPTIONS') {
      if (!origin || !origins.has(origin)) throw new ApiError(403, 'Deze website heeft geen toegang tot de server.');
      res.writeHead(204); res.end(); return;
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      send(res, 200, { ok: true, service: 'cellular-legends', serverTime: now() }); return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && ['/', '/index.html'].includes(pathname)) {
      const html = fs.readFileSync(path.join(rootDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : html); return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!pathname.startsWith('/api/')) throw new ApiError(404, 'Pagina niet gevonden.');
    // Managed hosts may put several players behind the same trusted proxy.
    // Keep a generous aggregate cap and a stricter individual session cap;
    // never trust an arbitrary client-supplied X-Forwarded-For header.
    limit('peer:' + req.socket.remoteAddress, 6000);
    if (req.method === 'POST' && pathname === '/api/squads') {
      limit('create:' + req.socket.remoteAddress, 20);
      const body = checkedObject(await readBody(req), ['name', 'sessionToken']);
      const name = checkedName(body.name), memberHash = hashToken(checkedToken(body.sessionToken));
      // A lost creation response must not leave a second orphan squad behind.
      const existingCode = createdSquads.get(memberHash);
      if (existingCode) {
        const existing = store.get(existingCode), session = existing?.sessions[memberHash];
        if (existing && !existing.closed && session && !session.left) {
          send(res, 200, envelope(fresh(existingCode), session.playerId)); return;
        }
        createdSquads.delete(memberHash);
      }
      let code;
      do { const entropy = randomBytes(6); code = Array.from(entropy, byte => CODE_ALPHABET[byte % 32]).join(''); } while (store.get(code));
      const playerId = randomUUID();
      const record = {
        state: { code, hostId: playerId, status: 'lobby', revision: 1, rulesVersion: 2,
          members: { [playerId]: rules.makeMember(playerId, name) }, currentLevel: 1,
          stageIndex: 0, teamKills: 0, teamXp: 0, pointsAwarded: 0, restId: null,
          journey: null, battle: null },
        sessions: { [memberHash]: { playerId, left: false } },
        invites: {}, quizAssignment: null, closed: false, createdAt: now(), creationHash: memberHash,
      };
      store.save(record);
      createdSquads.set(memberHash, code);
      send(res, 201, envelope(record, playerId)); return;
    }
    const match = /^\/api\/squads\/([A-HJ-NP-Z2-9]{6})(?:\/(join|invite|command|quiz))?$/.exec(pathname);
    if (!match || !CODE_RE.test(match[1])) throw new ApiError(404, 'Squad niet gevonden.');
    const [, code, operation] = match;
    if (operation === 'join' && req.method === 'POST') {
      limit('join:' + req.socket.remoteAddress, 60);
      const body = checkedObject(await readBody(req), ['name', 'sessionToken', 'invite']);
      const name = checkedName(body.name), memberHash = hashToken(checkedToken(body.sessionToken));
      const record = fresh(code), session = record.sessions[memberHash];
      if (session && !session.left && Object.hasOwn(record.state.members, session.playerId)) {
        send(res, 200, envelope(record, session.playerId)); return;
      }
      const inviteHash = hashToken(checkedToken(body.invite, 'uitnodiging'));
      if (!Object.hasOwn(record.invites, inviteHash) || record.invites[inviteHash].expiresAt <= now()) {
        throw new ApiError(403, 'Deze uitnodiging is ongeldig of verlopen. Vraag de host om een nieuwe link.');
      }
      if (record.state.status !== 'lobby') throw new ApiError(409, 'Wacht tot de squad klaar is met het gevecht.');
      if (Object.keys(record.state.members).length >= 4) throw new ApiError(409, 'Deze squad zit vol (maximaal 4 spelers).');
      if (!session && Object.keys(record.sessions).length >= 1000) throw new ApiError(429, 'Deze squad heeft te veel recente sessies. Maak een nieuwe squad.');
      const playerId = randomUUID(), engine = new rules.SquadEngine(record.state);
      record.state.members[playerId] = rules.makeMember(playerId, name, record.state.pointsAwarded, record.state.teamXp);
      record.sessions[memberHash] = { playerId, left: false };
      engine.memberJoined(playerId); engine.resetReady(); engine.publish(); store.save(record);
      send(res, 200, envelope(record, playerId)); return;
    }
    if (req.method === 'GET' && !operation) {
      const record = fresh(code), member = auth(req, record);
      store.touch(code);
      send(res, 200, envelope(record, member.playerId)); return;
    }
    if (req.method !== 'POST' || !['invite', 'command', 'quiz'].includes(operation)) throw new ApiError(405, 'Deze aanvraagmethode wordt niet ondersteund.');
    const body = await readBody(req);
    // Closed records remain private tombstones so a retried leave stays successful.
    let record = store.get(code);
    if (!record) throw new ApiError(404, 'Deze squad bestaat niet meer.');
    const member = auth(req, record, operation === 'command');
    if (!record.closed) record = fresh(code);
    if (operation === 'quiz') {
      checkedObject(body, ['battleId', 'turnNumber']);
      const b = record.state.battle;
      if (record.closed || record.state.status !== 'battle' || b?.activePlayerId !== member.playerId || b.phase !== 'player'
        || body.battleId !== b.id || body.turnNumber !== b.turnNumber || record.state.members[member.playerId].hp <= 0) {
        throw new ApiError(409, 'Deze beurt is voorbij. Wacht op jouw beurt.');
      }
      let assignment = record.quizAssignment;
      if (!assignment || assignment.battleId !== b.id || assignment.turnNumber !== b.turnNumber || assignment.playerId !== member.playerId) {
        const question = rules.chooseQuestion(record.state.members[member.playerId]);
        assignment = record.quizAssignment = { battleId: b.id, turnNumber: b.turnNumber, playerId: member.playerId,
          quizId: question.id };
        store.save(record);
      }
      const question = Object.values(rules.QUESTION_DATABASE).flat().find(q => q.id === assignment.quizId);
      send(res, 200, { ...envelope(record, member.playerId), question }); return;
    }
    if (operation === 'invite') {
      checkedObject(body, ['requestId']);
      const requestId = checkedRequestId(body.requestId), info = receiptInfo(record, member, requestId, 'invite', {});
      if (record.closed || member.left || record.state.hostId !== member.playerId) throw new ApiError(403, 'Alleen de host kan uitnodigingen maken.');
      if (!info.old && record.state.status !== 'lobby') throw new ApiError(409, 'Maak een uitnodiging tijdens de rustpauze.');
      const token = store.inviteToken(code, member.memberHash, requestId);
      if (!info.old) {
        for (const [inviteHash, invite] of Object.entries(record.invites)) if (invite.expiresAt <= now()) delete record.invites[inviteHash];
        if (Object.keys(record.invites).length >= 100) throw new ApiError(429, 'Er zijn al genoeg uitnodigingen. Gebruik een bestaande link.');
        record.invites[hashToken(token)] = { expiresAt: now() + 7 * 24 * 60 * 60 * 1000 };
        store.save(record, info.receipt);
      }
      send(res, 200, envelope(record, member.playerId, { inviteUrl: '/#join=' + code + '&invite=' + token })); return;
    }
    checkedObject(body, ['command', 'payload', 'requestId']);
    const payload = checkedPayload(body.command, body.payload), requestId = checkedRequestId(body.requestId);
    const info = receiptInfo(record, member, requestId, body.command, payload);
    if (info.old) {
      if (member.left) {
        if (body.command !== 'leave') throw new ApiError(403, 'Je hebt deze squad verlaten.');
        send(res, 200, { ok: true, serverTime: now() }); return;
      }
      send(res, 200, envelope(record, member.playerId)); return;
    }
    if (record.closed || member.left || !Object.hasOwn(record.state.members, member.playerId)) throw new ApiError(403, 'Je hebt deze squad verlaten.');
    if (body.command === 'action' && ['attack', 'skill'].includes(payload.type)) {
      const assignment = record.quizAssignment;
      if (!assignment || assignment.playerId !== member.playerId || assignment.battleId !== payload.battleId
        || assignment.turnNumber !== payload.turnNumber || assignment.quizId !== payload.quizId) {
        throw new ApiError(409, 'Open eerst de vraag voor deze beurt.');
      }
    }
    // fresh() and the engine operate on detached data; invalid commands never
    // partially spend mana, coins or materials in the persisted state.
    const engine = new rules.SquadEngine(record.state);
    try { engine.command(member.playerId, body.command, payload); }
    catch (error) { throw new ApiError(409, error.message); }
    if (body.command === 'leave') {
      record.sessions[member.memberHash].left = true;
      record.sessions[member.memberHash].departedAt = now();
      if (record.state.hostId === member.playerId) {
        record.state.hostId = Object.keys(record.state.members)[0] || null;
        // Old host capabilities are invalid after a transfer.
        record.invites = {};
      }
      if (!Object.keys(record.state.members).length) record.closed = true;
    }
    if (record.state.status === 'battle' && !record.closed) activeCodes.add(code); else activeCodes.delete(code);
    store.save(record, info.receipt);
    send(res, 200, body.command === 'leave' ? { ok: true, serverTime: now() } : envelope(record, member.playerId));
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof ApiError)) console.error('Multiplayer-serverfout:', error.code || error.name || 'onbekend');
      send(res, error.status || 500, { error: error instanceof ApiError ? error.message : 'De server kan deze actie nu niet uitvoeren. Probeer opnieuw.' });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;

  const app = {
    server, store, rules,
    get url() {
      const address = server.address();
      return address && typeof address !== 'string' ? 'http://127.0.0.1:' + address.port : null;
    },
    async listen() {
      if (closed) throw new Error('De server is gesloten.');
      if (server.listening) return app;
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListen); server.listen(port, host);
      });
      timer = setInterval(() => {
        try {
          for (const code of activeCodes) fresh(code);
          for (const [key, bucket] of buckets) if (bucket.until <= now()) buckets.delete(key);
          if (now() >= nextPrune) {
            for (const code of store.prune(now() - squadTtlMs)) activeCodes.delete(code);
            store.prunePrivate(now() - PRIVATE_RETENTION_MS);
            for (const [memberHash, code] of createdSquads) if (!store.get(code)) createdSquads.delete(memberHash);
            nextPrune = now() + 60000;
          }
        } catch (error) {
          console.error('Opslaan van multiplayer mislukt:', error.code || error.name);
        }
      }, options.tickIntervalMs ?? 250);
      timer.unref();
      return app;
    },
    async close() {
      if (closing) return closing;
      closed = true; clearInterval(timer);
      closing = (async () => {
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
          });
        }
        store.close();
      })();
      return closing;
    },
  };
  return app;
}

if (require.main === module) {
  let app;
  try { app = createGameServer(); }
  catch (error) { console.error('Multiplayer kan niet starten:', error.code || error.message); process.exitCode = 1; }
  if (app) {
    app.listen().then(() => console.log('Cellular Legends luistert op poort ' + app.server.address().port + '.'))
      .catch(error => { console.error('Multiplayer kan niet luisteren:', error.code || error.message); app.close().finally(() => { process.exitCode = 1; }); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      app.close().catch(error => { console.error('Afsluiten mislukt:', error.code || error.name); process.exitCode = 1; });
    });
  }
}

module.exports = { createGameServer };
