# 📺 MultiTube

Aplicação para assistir múltiplos vídeos/lives do YouTube simultaneamente em uma TV, controlados remotamente pelo celular via rede local.

---

## 🗂 Estrutura do Projeto

```
projetoMultiview/
├── server.js           → Servidor Node.js (Express + WebSocket)
├── package.json        → Dependências do projeto
├── multiview.html      → Tela da TV (exibe os vídeos)
└── controller.html     → Tela do Celular (controle remoto)
```

---

## ⚙️ Requisitos

- [Node.js](https://nodejs.org/) v18 ou superior
- TV e celular na **mesma rede Wi-Fi**

---

## 🚀 Como Iniciar

### 1. Instalar dependências (somente na primeira vez)

```bash
cd projetoMultiview
npm install
```

### 2. Iniciar o servidor

```bash
node server.js
```

O terminal exibirá os endereços disponíveis:

```
========================================
   🎬  MultiTube — YouTube Controller
========================================

📺  TV (MultiTube):   http://localhost:3031
📱  Celular (Ctrl):   http://localhost:3031/controller

🌐  Na rede local:
     📺 TV:    http://192.168.x.x:3031
     📱 Ctrl:  http://192.168.x.x:3031/controller

========================================
```

### 3. Abrir na TV

Acesse no navegador da TV:
```
http://192.168.x.x:3031
```

### 4. Abrir no Celular

Acesse no navegador do celular:
```
http://192.168.x.x:3031/controller
```

> 💡 Substitua `192.168.x.x` pelo IP exibido no terminal ao iniciar o servidor.

---

## 🎮 Funcionalidades do Controller (Celular)

| Ação | Como usar |
|------|-----------|
| ➕ **Adicionar vídeo** | Cole a URL do YouTube no campo e toque em **+** |
| 🗑️ **Remover vídeo** | Toque no ícone de lixeira ao lado do vídeo |
| 🔇 **Mutar vídeo** | Toque no ícone de volume do vídeo desejado |
| 🔊 **Desmutar vídeo** | Toque novamente no ícone de volume |
| 🔄 **Sync individual** | Toque no ícone de sincronizar de um vídeo para pular ao vivo |
| 🟢 **Sync todos** | Toque no botão verde **"Sincronizar Todos ao Vivo"** |

---

## 📺 Funcionalidades da TV (MultiTube)

- Exibe os vídeos em grid responsivo (2×2, 3×2, etc.)
- Atualiza automaticamente quando o controller adiciona/remove vídeos
- Indicador de status WebSocket no topo
- Todos os vídeos iniciam **mutados** por padrão
- Responde aos comandos de mute e sync em tempo real

---

## 🔗 Formatos de URL aceitos

```
https://www.youtube.com/watch?v=VIDEO_ID
https://youtu.be/VIDEO_ID
https://www.youtube.com/embed/VIDEO_ID
VIDEO_ID   (apenas o ID de 11 caracteres)
```

---

## 🛰️ Arquitetura

```
[Celular - controller.html]
        ↕ WebSocket
[Servidor Node.js - server.js]  ←→  Estado centralizado
        ↕ WebSocket
[TV - multiview.html]  (tela MultiTube)
```

Toda comunicação é feita em tempo real via **WebSocket**. O servidor mantém o estado (lista de vídeos e status de mute) e faz broadcast para todos os clientes conectados.

### Mensagens WebSocket

| Tipo | Direção | Descrição |
|------|---------|-----------|
| `add_video` | Controller → Server | Adiciona um vídeo |
| `remove_video` | Controller → Server | Remove um vídeo por índice |
| `toggle_mute` | Controller → Server | Alterna mute de um vídeo |
| `sync_video` | Controller → Server | Sincroniza um vídeo ao vivo |
| `sync_all` | Controller → Server | Sincroniza todos ao vivo |
| `get_state` | Qualquer → Server | Solicita estado atual |
| `state` | Server → Todos | Estado completo (lista + mutes) |

---

## 📦 Dependências

| Pacote | Versão | Uso |
|--------|--------|-----|
| [express](https://expressjs.com/) | ^4.18.2 | Servidor HTTP e rotas |
| [ws](https://github.com/websockets/ws) | ^8.16.0 | Comunicação WebSocket |

---

## 🖥️ Portas

| Porta | Serviço |
|-------|---------|
| `3031` | HTTP (MultiTube + controller) e WebSocket |

Para alterar a porta, edite a variável `PORT` no início do `server.js`.

