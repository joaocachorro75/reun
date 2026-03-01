const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 80;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const AUTH_USER = process.env.AUTH_USER || 'joao';
const AUTH_PASS = process.env.AUTH_PASS || 'toligado123';

// Caminhos para integração com agentes OpenClaw
const WORKSPACE_BASE = '/home/node/.openclaw';
const AGENTS = {
  'Robotic': { workspace: 'workspace', color: 'red' },
  'Becloud': { workspace: 'workspace-becloud', color: 'blue' },
  'Mesegue': { workspace: 'workspace-mesegue', color: 'pink' },
  'Mileide': { workspace: 'workspace-mileide', color: 'green' },
  'Ligadinho': { workspace: 'workspace-becloud', color: 'purple' } // usa workspace do Becloud
};

const sessions = {};
const onlineUsers = new Map();
const userSockets = new Map();
const channels = {
  '#toligado': { name: 'To-Ligado', description: 'Chat geral da equipe' },
  '#marketing': { name: 'Marketing', description: 'Mesegue, Mileide e João' },
  '#dev': { name: 'Desenvolvimento', description: 'Becloud e Robotic' }
};
const messages = {};

// ====== INTEGRAÇÃO COM AGENTES OPENCLAW ======

function writeToAgentInbox(agentName, messageData) {
  const agent = AGENTS[agentName];
  if (!agent) return;
  
  const inboxPath = path.join(WORKSPACE_BASE, agent.workspace, 'memory', 'IRC_INBOX.md');
  const inboxDir = path.dirname(inboxPath);
  
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString();
  const entry = `
### [${timestamp}]
**De:** ${messageData.author}
**Canal:** ${messageData.channel}
**Mensagem:** ${messageData.message}

---
`;
  
  let content = '';
  if (fs.existsSync(inboxPath)) {
    content = fs.readFileSync(inboxPath, 'utf-8');
  } else {
    content = `# 📥 Caixa de Entrada IRC

> Mensagens do chat IRC que mencionam este agente

---
`;
  }
  
  content = content.replace('---\n', '---\n' + entry);
  fs.writeFileSync(inboxPath, content);
  console.log(`📬 Mensagem escrita para ${agentName}: ${inboxPath}`);
}

function checkAgentOutbox(agentName) {
  const agent = AGENTS[agentName];
  if (!agent) return null;
  
  const outboxPath = path.join(WORKSPACE_BASE, agent.workspace, 'memory', 'IRC_OUTBOX.md');
  
  if (!fs.existsSync(outboxPath)) return null;
  
  const content = fs.readFileSync(outboxPath, 'utf-8');
  
  // Procurar mensagens não lidas
  const pendingMatch = content.match(/### PENDENTE\n\*\*Para:\*\* #(\w+)\n\*\*Mensagem:\*\* (.+?)\n/g);
  
  if (pendingMatch) {
    // Marcar como lido
    const newContent = content.replace(/### PENDENTE/g, '### ENVIADO');
    fs.writeFileSync(outboxPath, newContent);
    
    return pendingMatch.map(m => {
      const channelMatch = m.match(/\*\*Para:\*\* #(\w+)/);
      const msgMatch = m.match(/\*\*Mensagem:\*\* (.+?)\n/);
      return {
        channel: '#' + (channelMatch ? channelMatch[1] : 'toligado'),
        message: msgMatch ? msgMatch[1] : ''
      };
    });
  }
  
  return null;
}

// Verificar outboxes periodicamente
setInterval(() => {
  for (const agentName of Object.keys(AGENTS)) {
    const responses = checkAgentOutbox(agentName);
    if (responses) {
      responses.forEach(r => {
        const msg = {
          author: agentName,
          message: r.message,
          channel: r.channel,
          time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          timestamp: new Date().toISOString()
        };
        
        if (!messages[r.channel]) messages[r.channel] = [];
        messages[r.channel].push(msg);
        
        io.to(r.channel).emit('chat-message', msg);
        console.log(`📤 ${agentName} respondeu: ${r.message.substring(0, 50)}...`);
      });
    }
  }
}, 3000);

// ====== SERVIDOR ======

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Login
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>IRC To-Ligado</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-900 min-h-screen flex items-center justify-center">
<div class="bg-gray-800 p-8 rounded-lg max-w-md w-full">
<h1 class="text-2xl font-bold text-white mb-6">💬 IRC To-Ligado</h1>
<form onsubmit="login(event)" class="space-y-4">
<input type="text" id="username" placeholder="Usuário" class="w-full bg-gray-700 text-white rounded px-4 py-2" required>
<input type="password" id="password" placeholder="Senha" class="w-full bg-gray-700 text-white rounded px-4 py-2" required>
<button class="w-full bg-blue-600 text-white py-2 rounded">Entrar</button>
</form>
<p id="error" class="text-red-400 text-sm mt-4 hidden"></p>
</div>
<script>
async function login(e) {
  e.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
  });
  const data = await res.json();
  if (data.success) location.href = '/';
  else { document.getElementById('error').textContent = data.error; document.getElementById('error').classList.remove('hidden'); }
}
</script></body></html>`);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { username, created: Date.now() };
    res.setHeader('Set-Cookie', `token=${token}; Path=/; Max-Age=${60*60*24*7}`);
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
  }
});

// Middleware de auth
app.use((req, res, next) => {
  const token = req.headers.cookie?.split('token=')[1]?.split(';')[0];
  if (token && sessions[token]) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autorizado' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

// Socket.io
io.on('connection', (socket) => {
  console.log('Usuário conectado:', socket.id);
  
  socket.on('join', (data) => {
    const { name } = data;
    onlineUsers.set(socket.id, { name, channels: ['#toligado'] });
    userSockets.set(name, socket.id);
    socket.join('#toligado');
    socket.emit('channel-history', { channel: '#toligado', messages: messages['#toligado'] || [] });
    io.emit('online-users', Array.from(onlineUsers.values()));
  });
  
  socket.on('chat-message', (data) => {
    const { author, message, channel } = data;
    const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    
    const msg = { author, message, channel: channel || '#toligado', time, timestamp: new Date().toISOString() };
    
    if (!messages[msg.channel]) messages[msg.channel] = [];
    messages[msg.channel].push(msg);
    
    io.to(msg.channel).emit('chat-message', msg);
    console.log(`💬 ${author}: ${message}`);
    
    // ====== INTEGRAÇÃO COM AGENTES ======
    // Verificar menções
    const text = message.toLowerCase();
    
    // Detectar menção a agentes
    for (const agentName of Object.keys(AGENTS)) {
      if (text.includes('@' + agentName.toLowerCase()) || text.includes('@todos')) {
        // Escrever na inbox do agente
        writeToAgentInbox(agentName, { author, channel: msg.channel, message });
      }
    }
  });
  
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      onlineUsers.delete(socket.id);
      userSockets.delete(user.name);
      io.emit('online-users', Array.from(onlineUsers.values()));
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 IRC To-Ligado rodando na porta ${PORT}`);
  console.log(`📬 Integração com agentes OpenClaw ativa`);
});
