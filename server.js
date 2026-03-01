const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const url = require('url');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT) || 3031;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;
const PERSISTENT_KEYS = ['videos', 'muted', 'startSeconds', 'roomName'];
const MAX_VIDEOS_PER_ROOM = 12;

const CLEANUP_INTERVAL_MS = process.env.CLEANUP_INTERVAL_MS ? Number(process.env.CLEANUP_INTERVAL_MS) : 0;
const ROOM_IDLE_TIMEOUT_MS = process.env.ROOM_IDLE_TIMEOUT_MS
    ? Number(process.env.ROOM_IDLE_TIMEOUT_MS)
    : 30 * 60 * 1000;

const isProduction = process.env.NODE_ENV === 'production';

const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const GTAG_SNIPPET_RAW = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-X4ZH2142WK"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-X4ZH2142WK');
</script>
`;
const GTAG_SNIPPET = isProduction ? GTAG_SNIPPET_RAW : '';

function serveHtml(fileName, replacements, res) {
    const filePath = path.join(__dirname, fileName);
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            res.status(500).send('Erro ao carregar página');
            return;
        }
        let html = data;
        Object.keys(replacements).forEach((key) => {
            html = html.split(key).join(replacements[key]);
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    });
}

function log(level, message, meta = {}) {
    const payload = { timestamp: new Date().toISOString(), level, message, ...meta };
    if (isProduction) {
        console.log(JSON.stringify(payload));
    } else {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        console.log(`[${payload.timestamp}] [${level}] ${message}${metaStr}`);
    }
}

const lastActivityByRoom = new Map();
const deletedRoomCodes = new Set();

function loadAllStates() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const saved = JSON.parse(raw);
            const result = {};
            for (const [code, data] of Object.entries(saved)) {
                if (!ROOM_CODE_REGEX.test(code) || !data || typeof data !== 'object') continue;
                result[code] = {
                    videos: Array.isArray(data.videos) ? data.videos : [],
                    muted: Array.isArray(data.muted) ? data.muted : [],
                    startSeconds: Array.isArray(data.startSeconds) ? data.startSeconds : [],
                    roomName: typeof data.roomName === 'string' ? data.roomName : '',
                    focusedVideo: null,
                };
                const s = result[code];
                while (s.startSeconds.length < s.videos.length) s.startSeconds.push(0);
                while (s.startSeconds.length > s.videos.length) s.startSeconds.pop();
            }
            log('info', 'Estado restaurado', { rooms: Object.keys(result).length });
            return result;
        }
    } catch (err) {
        log('warn', 'Falha ao carregar state.json', { error: err.message });
    }
    return {};
}

const states = loadAllStates();

let _saveTimer = null;

function saveAllStatesSync() {
    const toSave = {};
    for (const [code, state] of Object.entries(states)) {
        toSave[code] = {};
        PERSISTENT_KEYS.forEach((k) => {
            toSave[code][k] = state[k];
        });
    }
    const tmpFile = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(toSave, null, 2), 'utf8');
    fs.renameSync(tmpFile, STATE_FILE);
}

function saveAllStates() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            saveAllStatesSync();
            log('info', 'Estado salvo', { rooms: Object.keys(states).length });
        } catch (err) {
            log('error', 'Falha ao salvar state.json', { error: err.message });
        }
    }, 400);
}

function getOrCreateRoom(code) {
    if (!states[code]) {
        states[code] = { videos: [], muted: [], startSeconds: [], roomName: '', focusedVideo: null };
        deletedRoomCodes.delete(code);
        log('info', 'Sala criada', { room: code });
    }
    lastActivityByRoom.set(code, Date.now());
    const s = states[code];
    if (!Array.isArray(s.startSeconds)) s.startSeconds = [];
    while (s.startSeconds.length < s.videos.length) s.startSeconds.push(0);
    while (s.startSeconds.length > s.videos.length) s.startSeconds.pop();
    if (typeof s.roomName !== 'string') s.roomName = '';
    return states[code];
}

function broadcastToRoom(roomId, message, exclude = null) {
    const data = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client.roomId === roomId && client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function countClientsInRoom(roomId) {
    let n = 0;
    wss.clients.forEach((client) => {
        if (client.roomId === roomId && client.readyState === WebSocket.OPEN) n++;
    });
    return n;
}

function extractVideoId(urlStr) {
    if (!urlStr) return null;
    urlStr = urlStr.trim();
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const pattern of patterns) {
        const match = urlStr.match(pattern);
        if (match && match[1]) return match[1];
    }
    return null;
}

/** Extrai segundos de início da URL (t=90, t=90s, start=90). Retorna 0 se ausente ou inválido. */
function extractStartSeconds(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return 0;
    const tMatch = urlStr.match(/[?&]t=(\d+)/i) || urlStr.match(/[?&]t=(\d+)s/i);
    if (tMatch) return Math.max(0, parseInt(tMatch[1], 10) || 0);
    const startMatch = urlStr.match(/[?&]start=(\d+)/i);
    if (startMatch) return Math.max(0, parseInt(startMatch[1], 10) || 0);
    return 0;
}

if (CLEANUP_INTERVAL_MS > 0 && ROOM_IDLE_TIMEOUT_MS > 0) {
    setInterval(() => {
        const now = Date.now();
        const toRemove = [];
        for (const [code, lastActivity] of lastActivityByRoom) {
            if (countClientsInRoom(code) === 0 && now - lastActivity >= ROOM_IDLE_TIMEOUT_MS) {
                toRemove.push(code);
            }
        }
        toRemove.forEach((code) => {
            delete states[code];
            lastActivityByRoom.delete(code);
            deletedRoomCodes.add(code);
            log('info', 'Sala removida por inatividade', { room: code });
        });
        if (toRemove.length) saveAllStates();
    }, CLEANUP_INTERVAL_MS);
}

app.use(express.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(
    helmet({
        contentSecurityPolicy: false,
        crossOriginOpenerPolicy: false,
        crossOriginEmbedderPolicy: false,
        originAgentCluster: false,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
);

app.get('/health', (req, res) => {
    res.status(200).json({ ok: true, rooms: Object.keys(states).length });
});

app.use(limiter);

app.get('/', (req, res) => {
    serveHtml('index.html', {
        '{{SITE_URL}}': SITE_URL,
        '{{CANONICAL_URL}}': `${SITE_URL}/`,
        '{{META_ROBOTS}}': 'index, follow',
        '{{GTAG_SNIPPET}}': GTAG_SNIPPET,
    }, res);
});

app.get('/view', (req, res) => {
    serveHtml('multiview.html', {
        '{{SITE_URL}}': SITE_URL,
        '{{CANONICAL_URL}}': `${SITE_URL}/view`,
        '{{META_ROBOTS}}': 'index, follow',
        '{{GTAG_SNIPPET}}': GTAG_SNIPPET,
    }, res);
});

app.get('/view/:code', (req, res) => {
    const code = (req.params.code || '').toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
        res.redirect('/view');
        return;
    }
    serveHtml('multiview.html', {
        '{{SITE_URL}}': SITE_URL,
        '{{CANONICAL_URL}}': `${SITE_URL}/view/${code}`,
        '{{META_ROBOTS}}': 'noindex, follow',
        '{{GTAG_SNIPPET}}': GTAG_SNIPPET,
    }, res);
});

app.get('/controller', (req, res) => {
    serveHtml('controller.html', {
        '{{SITE_URL}}': SITE_URL,
        '{{CANONICAL_URL}}': `${SITE_URL}/controller`,
        '{{META_ROBOTS}}': 'index, follow',
        '{{GTAG_SNIPPET}}': GTAG_SNIPPET,
    }, res);
});

app.get('/c/:code', (req, res) => {
    const code = (req.params.code || '').toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
        res.redirect('/controller');
        return;
    }
    serveHtml('controller.html', {
        '{{SITE_URL}}': SITE_URL,
        '{{CANONICAL_URL}}': `${SITE_URL}/c/${code}`,
        '{{META_ROBOTS}}': 'noindex, follow',
        '{{GTAG_SNIPPET}}': GTAG_SNIPPET,
    }, res);
});

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`);
});

app.get('/sitemap.xml', (req, res) => {
    const lastmod = new Date().toISOString().slice(0, 10);
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${SITE_URL}/view</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${SITE_URL}/controller</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
</urlset>
`);
});

app.get('/api/state', (req, res) => {
    const code = (req.query.room || '').toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
        return res.status(400).json({ error: 'Código de sala inválido' });
    }
    const state = states[code];
    if (!state) return res.json({ videos: [], muted: [], startSeconds: [], roomName: '', focusedVideo: null });
    res.json(state);
});

app.delete('/api/state', (req, res) => {
    const code = (req.query.room || '').toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
        return res.status(400).json({ error: 'Código de sala inválido' });
    }
    if (states[code]) {
        states[code].videos = [];
        states[code].muted = [];
        states[code].startSeconds = [];
        states[code].focusedVideo = null;
        saveAllStates();
        broadcastToRoom(code, { type: 'state', ...states[code] });
    }
    res.json({ ok: true, message: 'Estado da sala limpo com sucesso' });
});

app.use(express.static(path.join(__dirname)));

wss.on('connection', (ws, req) => {
    const parsed = url.parse(req.url || '', true);
    const room = (parsed.query && parsed.query.room ? parsed.query.room : '').toString().toUpperCase().trim();

    if (!ROOM_CODE_REGEX.test(room)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Código de sala inválido. Use 6 caracteres A-Z ou 0-9.' }));
        ws.close();
        return;
    }

    if (deletedRoomCodes.has(room)) {
        ws.send(JSON.stringify({ type: 'room_not_found', message: 'Sala não encontrada ou foi removida.' }));
        ws.close();
        return;
    }

    if (!states[room]) {
        getOrCreateRoom(room);
    } else {
        lastActivityByRoom.set(room, Date.now());
    }

    ws.roomId = room;
    const state = states[room];
    const ip = req.socket.remoteAddress;
    log('info', 'Cliente conectado', { ip, room });

    ws.send(JSON.stringify({ type: 'state', ...state }));

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            log('warn', 'Mensagem inválida', { raw: String(raw).slice(0, 100) });
            return;
        }

        const roomState = states[ws.roomId];
        if (!roomState) return;

        lastActivityByRoom.set(ws.roomId, Date.now());

        switch (msg.type) {
            case 'add_video': {
                if (roomState.videos.length >= MAX_VIDEOS_PER_ROOM) {
                    ws.send(
                        JSON.stringify({
                            type: 'error',
                            message: `Máximo de ${MAX_VIDEOS_PER_ROOM} vídeos por sala. Remova um para adicionar outro.`,
                        })
                    );
                    return;
                }
                const urlInput = msg.url || msg.videoId || '';
                const videoId = extractVideoId(urlInput);
                if (!videoId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'URL inválida do YouTube' }));
                    return;
                }
                if (roomState.videos.includes(videoId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Vídeo já adicionado' }));
                    return;
                }
                const startSec = typeof msg.start === 'number' && msg.start >= 0 ? Math.floor(msg.start) : extractStartSeconds(urlInput);
                roomState.videos.push(videoId);
                roomState.muted.push(true);
                roomState.startSeconds.push(startSec);
                saveAllStates();
                broadcastToRoom(ws.roomId, { type: 'state', ...roomState });
                break;
            }

            case 'remove_video': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= roomState.videos.length) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Índice inválido' }));
                    return;
                }
                roomState.videos.splice(idx, 1);
                roomState.muted.splice(idx, 1);
                if (Array.isArray(roomState.startSeconds) && idx < roomState.startSeconds.length) {
                    roomState.startSeconds.splice(idx, 1);
                }
                if (roomState.focusedVideo === idx) {
                    roomState.focusedVideo = null;
                } else if (roomState.focusedVideo !== null && roomState.focusedVideo > idx) {
                    roomState.focusedVideo--;
                }
                saveAllStates();
                broadcastToRoom(ws.roomId, { type: 'state', ...roomState });
                break;
            }

            case 'reorder_videos': {
                if (!Array.isArray(msg.videos) || !Array.isArray(msg.muted)) return;
                roomState.videos = msg.videos;
                roomState.muted = msg.muted;
                if (Array.isArray(msg.startSeconds) && msg.startSeconds.length === msg.videos.length) {
                    roomState.startSeconds = msg.startSeconds;
                } else if (Array.isArray(roomState.startSeconds)) {
                    while (roomState.startSeconds.length < roomState.videos.length) roomState.startSeconds.push(0);
                    while (roomState.startSeconds.length > roomState.videos.length) roomState.startSeconds.pop();
                } else {
                    roomState.startSeconds = roomState.videos.map(() => 0);
                }
                if (msg.focusedVideo !== undefined && (msg.focusedVideo === null || (Number.isInteger(msg.focusedVideo) && msg.focusedVideo >= 0 && msg.focusedVideo < roomState.videos.length))) {
                    roomState.focusedVideo = msg.focusedVideo;
                }
                saveAllStates();
                broadcastToRoom(ws.roomId, { type: 'state', ...roomState });
                break;
            }

            case 'toggle_mute': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= roomState.videos.length) return;
                roomState.muted[idx] = !roomState.muted[idx];
                saveAllStates();
                broadcastToRoom(ws.roomId, {
                    type: 'toggle_mute',
                    index: idx,
                    muted: roomState.muted[idx],
                });
                break;
            }

            case 'set_mute': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= roomState.videos.length) return;
                roomState.muted[idx] = !!msg.muted;
                saveAllStates();
                broadcastToRoom(ws.roomId, {
                    type: 'toggle_mute',
                    index: idx,
                    muted: roomState.muted[idx],
                });
                break;
            }

            case 'sync_video': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= roomState.videos.length) return;
                broadcastToRoom(ws.roomId, { type: 'sync_video', index: idx });
                break;
            }

            case 'sync_all': {
                broadcastToRoom(ws.roomId, { type: 'sync_all' });
                break;
            }

            case 'play_pause_all': {
                const play = typeof msg.play === 'boolean' ? msg.play : true;
                broadcastToRoom(ws.roomId, { type: 'play_pause_all', play });
                break;
            }

            case 'focus_video': {
                const idx = msg.index;

                if (idx === null || idx === undefined) {
                    roomState.focusedVideo = null;
                    broadcastToRoom(ws.roomId, { type: 'focus_video', index: null, muted: roomState.muted });
                    break;
                }

                const i = parseInt(idx);
                if (i < 0 || i >= roomState.videos.length) return;

                roomState.focusedVideo = i;
                roomState.muted = roomState.muted.map((_, j) => j !== i);
                saveAllStates();
                broadcastToRoom(ws.roomId, { type: 'focus_video', index: i, muted: [...roomState.muted] });
                break;
            }

            case 'get_state': {
                ws.send(JSON.stringify({ type: 'state', ...roomState }));
                break;
            }

            case 'set_room_name': {
                roomState.roomName = typeof msg.roomName === 'string' ? msg.roomName.trim().slice(0, 80) : '';
                saveAllStates();
                broadcastToRoom(ws.roomId, { type: 'state', ...roomState });
                break;
            }

            default:
                log('warn', 'Tipo desconhecido', { type: msg.type });
        }
    });

    ws.on('close', () => {
        log('info', 'Cliente desconectado', { ip, room: ws.roomId });
    });

    ws.on('error', (err) => {
        log('error', 'Erro WS', { message: err.message });
    });
});

function shutdown() {
    log('info', 'Encerrando servidor (graceful shutdown)');
    clearTimeout(_saveTimer);
    try {
        saveAllStatesSync();
    } catch (err) {
        log('error', 'Falha ao salvar estado no shutdown', { error: err.message });
    }
    server.close(() => {
        log('info', 'Servidor fechado');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    const ips = [];

    Object.values(interfaces).forEach((iface) => {
        iface.forEach((details) => {
            if (details.family === 'IPv4' && !details.internal) {
                ips.push(details.address);
            }
        });
    });

    const roomCount = Object.keys(states).length;
    log('info', 'MultiTube iniciado', {
        port: PORT,
        stateFile: STATE_FILE,
        rooms: roomCount,
        home: `http://localhost:${PORT}`,
        controller: `http://localhost:${PORT}/controller`,
        view: `http://localhost:${PORT}/view`,
    });
    if (!isProduction) {
        console.log('\n========================================');
        console.log('   🎬  MultiTube — Salas por código     ');
        console.log('========================================');
        console.log(`\n🏠  Home:        http://localhost:${PORT}`);
        console.log(`📱  Controller:  http://localhost:${PORT}/controller`);
        console.log(`📺  Cinema:      http://localhost:${PORT}/view`);
        if (ips.length > 0) {
            console.log('\n🌐  Na rede local:');
            ips.forEach((ip) => {
                console.log(`     http://${ip}:${PORT}`);
            });
        }
        console.log(`\n💾  Cache: ${STATE_FILE}`);
        console.log(`📋  Salas em cache: ${roomCount}`);
        console.log('\n========================================\n');
    }
});
