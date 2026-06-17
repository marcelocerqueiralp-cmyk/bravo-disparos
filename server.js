const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Estado em memória
let fila = [];
let disparando = false;
let pausado = false;
let log = [];
let stats = { total: 0, enviados: 0, erros: 0, pendentes: 0 };

const EVOLUTION_URL = process.env.EVOLUTION_URL || '';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || '';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'bravo';

// Delay entre mensagens (ms) — proteção anti-ban
const DELAY_MIN = parseInt(process.env.DELAY_MIN || '8000');
const DELAY_MAX = parseInt(process.env.DELAY_MAX || '15000');

function delay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

function formatarNumero(num) {
  let n = String(num).replace(/\D/g, '');
  if (n.length === 11 && n[0] !== '55') n = '55' + n;
  if (n.length === 10 && n[0] !== '55') n = '55' + n;
  return n + '@s.whatsapp.net';
}

function personalizarMensagem(template, contato) {
  return template
    .replace(/\{nome\}/gi, contato.nome || '')
    .replace(/\{cpf\}/gi, contato.cpf || '')
    .replace(/\{telefone\}/gi, contato.telefone || '');
}

async function enviarMensagem(contato, mensagem) {
  const numero = formatarNumero(contato.telefone);
  const texto = personalizarMensagem(mensagem, contato);

  const resp = await axios.post(
    `${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`,
    { number: numero, text: texto },
    { headers: { apikey: EVOLUTION_KEY }, timeout: 15000 }
  );
  return resp.data;
}

async function processarFila(mensagem) {
  disparando = true;
  pausado = false;

  for (let i = 0; i < fila.length; i++) {
    if (pausado) {
      log.push({ hora: new Date().toLocaleTimeString('pt-BR'), tipo: 'info', msg: 'Disparo pausado pelo usuário.' });
      break;
    }

    const contato = fila[i];
    if (contato.status !== 'pendente') continue;

    try {
      await enviarMensagem(contato, mensagem);
      contato.status = 'enviado';
      stats.enviados++;
      stats.pendentes--;
      log.push({ hora: new Date().toLocaleTimeString('pt-BR'), tipo: 'ok', msg: `✅ ${contato.nome} (${contato.telefone})` });
    } catch (e) {
      contato.status = 'erro';
      contato.erro = e.message;
      stats.erros++;
      stats.pendentes--;
      log.push({ hora: new Date().toLocaleTimeString('pt-BR'), tipo: 'erro', msg: `❌ ${contato.nome} (${contato.telefone}) — ${e.message}` });
    }

    if (i < fila.length - 1 && !pausado) {
      await delay(DELAY_MIN, DELAY_MAX);
    }
  }

  disparando = false;
  log.push({ hora: new Date().toLocaleTimeString('pt-BR'), tipo: 'info', msg: '🏁 Disparo finalizado.' });
}

// Rotas API

app.post('/importar', upload.single('arquivo'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const contatos = dados.map((row, i) => {
      const keys = Object.keys(row).map(k => k.toLowerCase());
      const getVal = (nomes) => {
        for (const n of nomes) {
          const k = Object.keys(row).find(k => k.toLowerCase().includes(n));
          if (k) return String(row[k]).trim();
        }
        return '';
      };

      return {
        id: i,
        nome: getVal(['nome', 'name']),
        cpf: getVal(['cpf']),
        telefone: getVal(['telefone', 'fone', 'celular', 'whatsapp', 'numero', 'número']),
        status: 'pendente',
        erro: ''
      };
    }).filter(c => c.telefone.replace(/\D/g, '').length >= 10);

    fila = contatos;
    stats = { total: contatos.length, enviados: 0, erros: 0, pendentes: contatos.length };
    log = [];

    fs.unlinkSync(req.file.path);
    res.json({ ok: true, total: contatos.length, preview: contatos.slice(0, 5) });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.post('/disparar', express.json(), (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem) return res.status(400).json({ ok: false, erro: 'Mensagem obrigatória' });
  if (disparando) return res.status(400).json({ ok: false, erro: 'Já está disparando' });
  if (fila.length === 0) return res.status(400).json({ ok: false, erro: 'Importe uma planilha primeiro' });

  processarFila(mensagem);
  res.json({ ok: true, msg: 'Disparo iniciado' });
});

app.post('/pausar', (req, res) => {
  pausado = true;
  res.json({ ok: true });
});

app.post('/reiniciar', (req, res) => {
  fila.forEach(c => { if (c.status !== 'enviado') { c.status = 'pendente'; c.erro = ''; } });
  stats.pendentes = fila.filter(c => c.status === 'pendente').length;
  stats.erros = 0;
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  res.json({ disparando, pausado, stats, log: log.slice(-50), fila: fila.slice(0, 100) });
});

app.get('/qrcode', async (req, res) => {
  try {
    const r = await axios.get(`${EVOLUTION_URL}/instance/connect/${INSTANCE_NAME}`, {
      headers: { apikey: EVOLUTION_KEY }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/conexao', async (req, res) => {
  try {
    const r = await axios.get(`${EVOLUTION_URL}/instance/connectionState/${INSTANCE_NAME}`, {
      headers: { apikey: EVOLUTION_KEY }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Frontend
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bravo Disparos</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f0f0f; color: #f0f0f0; min-height: 100vh; }
  .header { background: #1a1a2e; padding: 16px 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #25d366; }
  .header h1 { font-size: 20px; color: #25d366; }
  .header .status-badge { margin-left: auto; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .connected { background: #25d36620; color: #25d366; border: 1px solid #25d366; }
  .disconnected { background: #ff444420; color: #ff4444; border: 1px solid #ff4444; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .card h2 { font-size: 15px; color: #aaa; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; }
  .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s; }
  .btn-green { background: #25d366; color: #000; }
  .btn-green:hover { background: #1db954; }
  .btn-red { background: #ff4444; color: #fff; }
  .btn-gray { background: #333; color: #fff; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; text-align: center; }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 12px; color: #888; margin-top: 4px; }
  .total .num { color: #fff; }
  .enviados .num { color: #25d366; }
  .erros .num { color: #ff4444; }
  .pendentes .num { color: #f0a500; }
  textarea { width: 100%; background: #111; border: 1px solid #333; color: #f0f0f0; border-radius: 8px; padding: 12px; font-size: 14px; resize: vertical; min-height: 100px; }
  .log-box { background: #111; border: 1px solid #222; border-radius: 8px; padding: 12px; height: 200px; overflow-y: auto; font-size: 13px; font-family: monospace; }
  .log-ok { color: #25d366; }
  .log-erro { color: #ff4444; }
  .log-info { color: #888; }
  .upload-area { border: 2px dashed #333; border-radius: 10px; padding: 30px; text-align: center; cursor: pointer; transition: all 0.2s; }
  .upload-area:hover { border-color: #25d366; }
  .hint { font-size: 12px; color: #666; margin-top: 6px; }
  .tags { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .tag { background: #25d36620; color: #25d366; border: 1px solid #25d36640; border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
  .tag:hover { background: #25d36640; }
  .progress-bar { height: 6px; background: #222; border-radius: 3px; margin-top: 12px; overflow: hidden; }
  .progress-fill { height: 100%; background: #25d366; border-radius: 3px; transition: width 0.5s; }
  .flex { display: flex; gap: 10px; align-items: center; }
  .qr-img { max-width: 200px; margin: 0 auto; display: block; }
  input[type=file] { display: none; }
  .info-box { background: #1a2a1a; border: 1px solid #25d36640; border-radius: 8px; padding: 12px; font-size: 13px; color: #aaa; margin-top: 12px; }
</style>
</head>
<body>
<div class="header">
  <span style="font-size:24px">💬</span>
  <h1>Bravo Disparos</h1>
  <span class="status-badge disconnected" id="badge">Verificando...</span>
</div>

<div class="container">

  <!-- Stats -->
  <div class="stats">
    <div class="stat total"><div class="num" id="s-total">0</div><div class="label">Total</div></div>
    <div class="stat enviados"><div class="num" id="s-enviados">0</div><div class="label">Enviados</div></div>
    <div class="stat erros"><div class="num" id="s-erros">0</div><div class="label">Erros</div></div>
    <div class="stat pendentes"><div class="num" id="s-pendentes">0</div><div class="label">Pendentes</div></div>
  </div>
  <div class="progress-bar"><div class="progress-fill" id="progresso" style="width:0%"></div></div>

  <!-- Conexão -->
  <div class="card" style="margin-top:20px">
    <h2>📱 Conexão WhatsApp</h2>
    <div class="flex">
      <button class="btn btn-green" onclick="verQR()">Ver QR Code</button>
      <button class="btn btn-gray" onclick="verificarConexao()">Verificar Conexão</button>
    </div>
    <div id="qr-area" style="margin-top:16px"></div>
  </div>

  <!-- Importar -->
  <div class="card">
    <h2>📂 Importar Planilha</h2>
    <label for="arquivo">
      <div class="upload-area" id="drop-area">
        <div style="font-size:32px">📊</div>
        <div style="margin-top:8px">Clique para selecionar a planilha</div>
        <div class="hint">Excel (.xlsx) ou CSV — precisa ter colunas: Nome, Telefone, CPF</div>
      </div>
    </label>
    <input type="file" id="arquivo" accept=".xlsx,.xls,.csv" onchange="importar(this)">
    <div id="import-result"></div>
  </div>

  <!-- Mensagem -->
  <div class="card">
    <h2>✉️ Mensagem</h2>
    <textarea id="mensagem" placeholder="Digite sua mensagem aqui...

Use {nome} para personalizar com o nome do contato."></textarea>
    <div class="tags" style="margin-top:8px">
      <span class="tag" onclick="inserirTag('{nome}')">+nome</span>
      <span class="tag" onclick="inserirTag('{cpf}')">+cpf</span>
      <span class="tag" onclick="inserirTag('{telefone}')">+telefone</span>
    </div>
    <div class="info-box">
      💡 Exemplo: <i>"Olá {nome}, temos uma proposta de crédito consignado liberada pra você! Quer saber mais? Responda SIM."</i>
    </div>
  </div>

  <!-- Controles -->
  <div class="card">
    <h2>🚀 Controles</h2>
    <div class="flex">
      <button class="btn btn-green" id="btn-disparar" onclick="disparar()">▶ Iniciar Disparo</button>
      <button class="btn btn-red" id="btn-pausar" onclick="pausar()" disabled>⏸ Pausar</button>
      <button class="btn btn-gray" onclick="reiniciar()">🔄 Reiniciar Erros</button>
    </div>
    <div class="info-box" style="margin-top:12px">
      ⚠️ O sistema envia uma mensagem a cada 8-15 segundos automaticamente para proteger seu número.
    </div>
  </div>

  <!-- Log -->
  <div class="card">
    <h2>📋 Log em Tempo Real</h2>
    <div class="log-box" id="log-box">
      <div class="log-info">Aguardando...</div>
    </div>
  </div>

</div>

<script>
let logAnterior = 0;

function inserirTag(tag) {
  const t = document.getElementById('mensagem');
  const pos = t.selectionStart;
  t.value = t.value.slice(0, pos) + tag + t.value.slice(t.selectionEnd);
  t.focus();
}

async function verQR() {
  const area = document.getElementById('qr-area');
  area.innerHTML = '<div style="color:#888">Carregando QR Code...</div>';
  try {
    const r = await fetch('/qrcode');
    const d = await r.json();
    if (d.base64) {
      area.innerHTML = '<img class="qr-img" src="' + d.base64 + '"><div style="text-align:center;color:#888;font-size:12px;margin-top:8px">Escaneie com o WhatsApp</div>';
    } else {
      area.innerHTML = '<div style="color:#25d366">✅ Número já conectado!</div>';
    }
  } catch(e) {
    area.innerHTML = '<div style="color:#ff4444">Erro: ' + e.message + '</div>';
  }
}

async function verificarConexao() {
  try {
    const r = await fetch('/conexao');
    const d = await r.json();
    const conectado = d.state === 'open';
    document.getElementById('badge').textContent = conectado ? '✅ Conectado' : '❌ Desconectado';
    document.getElementById('badge').className = 'status-badge ' + (conectado ? 'connected' : 'disconnected');
  } catch(e) {}
}

async function importar(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('arquivo', file);
  document.getElementById('import-result').innerHTML = '<div style="color:#888;margin-top:12px">Importando...</div>';
  try {
    const r = await fetch('/importar', { method: 'POST', body: form });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('import-result').innerHTML = 
        '<div style="color:#25d366;margin-top:12px">✅ ' + d.total + ' contatos importados com sucesso!</div>' +
        '<div style="color:#888;font-size:12px;margin-top:4px">Prévia: ' + d.preview.map(c => c.nome || c.telefone).join(', ') + '...</div>';
    } else {
      document.getElementById('import-result').innerHTML = '<div style="color:#ff4444;margin-top:12px">❌ ' + d.erro + '</div>';
    }
  } catch(e) {
    document.getElementById('import-result').innerHTML = '<div style="color:#ff4444;margin-top:12px">❌ ' + e.message + '</div>';
  }
}

async function disparar() {
  const mensagem = document.getElementById('mensagem').value.trim();
  if (!mensagem) return alert('Digite a mensagem primeiro!');
  if (!confirm('Confirma o disparo?')) return;
  await fetch('/disparar', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ mensagem }) });
  document.getElementById('btn-pausar').disabled = false;
}

async function pausar() {
  await fetch('/pausar', { method: 'POST' });
  document.getElementById('btn-pausar').disabled = true;
}

async function reiniciar() {
  await fetch('/reiniciar', { method: 'POST' });
}

async function atualizarStatus() {
  try {
    const r = await fetch('/status');
    const d = await r.json();
    document.getElementById('s-total').textContent = d.stats.total;
    document.getElementById('s-enviados').textContent = d.stats.enviados;
    document.getElementById('s-erros').textContent = d.stats.erros;
    document.getElementById('s-pendentes').textContent = d.stats.pendentes;
    const pct = d.stats.total > 0 ? Math.round((d.stats.enviados / d.stats.total) * 100) : 0;
    document.getElementById('progresso').style.width = pct + '%';

    if (d.log.length !== logAnterior) {
      const box = document.getElementById('log-box');
      box.innerHTML = d.log.map(l => 
        '<div class="log-' + l.tipo + '">[' + l.hora + '] ' + l.msg + '</div>'
      ).join('');
      box.scrollTop = box.scrollHeight;
      logAnterior = d.log.length;
    }
  } catch(e) {}
}

verificarConexao();
setInterval(atualizarStatus, 2000);
setInterval(verificarConexao, 30000);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bravo Disparos rodando na porta ${PORT}`));
