const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3031;

// ─── Persistência em disco ──────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

// Campos que SÃO persistidos (focusedVideo é estado de UI, não salvo)
const PERSISTENT_KEYS = ['videos', 'muted'];

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw  = fs.readFileSync(STATE_FILE, 'utf8');
            const saved = JSON.parse(raw);
            console.log(`[Cache] Estado restaurado: ${saved.videos?.length ?? 0} vídeo(s)`);
            return {
                videos:       Array.isArray(saved.videos) ? saved.videos : [],
                muted:        Array.isArray(saved.muted)  ? saved.muted  : [],
                focusedVideo: null   // sempre reinicia sem fullscreen
            };
        }
    } catch (err) {
        console.warn('[Cache] Falha ao carregar state.json:', err.message);
    }
    return { videos: [], muted: [], focusedVideo: null };
}

// Debounce: evita escrever disco a cada mensagem em rajada
let _saveTimer = null;
function saveState() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        const toSave = {};
        PERSISTENT_KEYS.forEach(k => { toSave[k] = state[k]; });
        fs.writeFile(STATE_FILE, JSON.stringify(toSave, null, 2), (err) => {
            if (err) console.error('[Cache] Falha ao salvar state.json:', err.message);
            else     console.log(`[Cache] Estado salvo (${state.videos.length} vídeo(s))`);
        });
    }, 400); // 400 ms de debounce
}

// ─── Estado global da aplicação ────────────────────────────────────────────
let state = loadState();

// ─── Servir arquivos estáticos ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Rota raiz → TV (MultiTube)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'multiview.html'));
});

// Rota do controller
app.get('/controller', (req, res) => {
    res.sendFile(path.join(__dirname, 'controller.html'));
});

// API REST para obter estado atual
app.get('/api/state', (req, res) => {
    res.json(state);
});

// API REST para limpar todos os vídeos salvos
app.delete('/api/state', (req, res) => {
    state.videos       = [];
    state.muted        = [];
    state.focusedVideo = null;
    saveState();
    broadcastAll({ type: 'state', ...state });
    res.json({ ok: true, message: 'Estado limpo com sucesso' });
    console.log('[Cache] Estado limpo via API');
});

// ─── Broadcast para todos os clientes ──────────────────────────────────────
function broadcast(message, exclude = null) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Broadcast para todos (inclui o remetente)
function broadcastAll(message) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// ─── Função para extrair videoId de URL do YouTube ─────────────────────────
function extractVideoId(url) {
    if (!url) return null;
    url = url.trim();
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
    }
    return null;
}

// ─── WebSocket: gerenciar conexões ─────────────────────────────────────────
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[WS] Cliente conectado: ${ip}`);

    // Enviar estado atual para o novo cliente
    ws.send(JSON.stringify({ type: 'state', ...state }));

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            console.error('[WS] Mensagem inválida:', raw);
            return;
        }

        console.log('[WS] Mensagem recebida:', msg);

        switch (msg.type) {

            // ── Adicionar vídeo ─────────────────────────────────────────
            case 'add_video': {
                const videoId = extractVideoId(msg.url || msg.videoId || '');
                if (!videoId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'URL inválida do YouTube' }));
                    return;
                }
                if (state.videos.includes(videoId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Vídeo já adicionado' }));
                    return;
                }
                state.videos.push(videoId);
                state.muted.push(true); // inicia mutado
                saveState();
                broadcastAll({ type: 'state', ...state });
                break;
            }

            // ── Remover vídeo ───────────────────────────────────────────
            case 'remove_video': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= state.videos.length) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Índice inválido' }));
                    return;
                }
                state.videos.splice(idx, 1);
                state.muted.splice(idx, 1);
                // Ajustar focusedVideo após remoção
                if (state.focusedVideo === idx) {
                    state.focusedVideo = null;
                } else if (state.focusedVideo !== null && state.focusedVideo > idx) {
                    state.focusedVideo--;
                }
                saveState();
                broadcastAll({ type: 'state', ...state });
                break;
            }

            // ── Reordenar vídeos ────────────────────────────────────────
            case 'reorder_videos': {
                if (!Array.isArray(msg.videos) || !Array.isArray(msg.muted)) return;
                state.videos = msg.videos;
                state.muted = msg.muted;
                saveState();
                broadcastAll({ type: 'state', ...state });
                break;
            }

            // ── Mutar/desmutar vídeo individual ─────────────────────────
            case 'toggle_mute': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= state.videos.length) return;
                state.muted[idx] = !state.muted[idx];
                saveState();
                broadcastAll({
                    type: 'toggle_mute',
                    index: idx,
                    muted: state.muted[idx]
                });
                break;
            }

            // ── Definir mute explicitamente ─────────────────────────────
            case 'set_mute': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= state.videos.length) return;
                state.muted[idx] = !!msg.muted;
                saveState();
                broadcastAll({
                    type: 'toggle_mute',
                    index: idx,
                    muted: state.muted[idx]
                });
                break;
            }

            // ── Sincronizar vídeo individual ao vivo ────────────────────
            case 'sync_video': {
                const idx = parseInt(msg.index);
                if (idx < 0 || idx >= state.videos.length) return;
                broadcastAll({ type: 'sync_video', index: idx });
                break;
            }

            // ── Sincronizar TODOS ao vivo ────────────────────────────────
            case 'sync_all': {
                broadcastAll({ type: 'sync_all' });
                break;
            }

            // ── Focar vídeo em fullscreen ────────────────────────────────
            case 'focus_video': {
                const idx = msg.index;

                if (idx === null || idx === undefined) {
                    // Sair do fullscreen — restaurar mutes anteriores
                    state.focusedVideo = null;
                    broadcastAll({ type: 'focus_video', index: null, muted: state.muted });
                    break;
                }

                const i = parseInt(idx);
                if (i < 0 || i >= state.videos.length) return;

                state.focusedVideo = i;
                // Desmutar o vídeo focado, mutar todos os demais
                state.muted = state.muted.map((_, j) => j !== i);
                saveState();

                broadcastAll({ type: 'focus_video', index: i, muted: [...state.muted] });
                break;
            }

            // ── Solicitar estado atual ────────────────────────────────────
            case 'get_state': {
                ws.send(JSON.stringify({ type: 'state', ...state }));
                break;
            }

            default:
                console.warn('[WS] Tipo desconhecido:', msg.type);
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Cliente desconectado: ${ip}`);
    });

    ws.on('error', (err) => {
        console.error('[WS] Erro:', err.message);
    });
});

// ─── Iniciar servidor ───────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    const ips = [];

    Object.values(interfaces).forEach(iface => {
        iface.forEach(details => {
            if (details.family === 'IPv4' && !details.internal) {
                ips.push(details.address);
            }
        });
    });

    console.log('\n========================================');
    console.log('   🎬  MultiTube — YouTube Controller   ');
    console.log('========================================');
    console.log(`\n📺  TV (MultiTube):   http://localhost:${PORT}`);
    console.log(`📱  Celular (Ctrl):   http://localhost:${PORT}/controller`);
    if (ips.length > 0) {
        console.log('\n🌐  Na rede local:');
        ips.forEach(ip => {
            console.log(`     📺 TV:    http://${ip}:${PORT}`);
            console.log(`     📱 Ctrl:  http://${ip}:${PORT}/controller`);
        });
    }
    console.log(`\n💾  Cache: ${STATE_FILE}`);
    console.log(`📋  Vídeos em cache: ${state.videos.length}`);
    if (state.videos.length > 0) {
        state.videos.forEach((id, i) => console.log(`     ${i + 1}. ${id}`));
    }
    console.log('\n========================================\n');
});

