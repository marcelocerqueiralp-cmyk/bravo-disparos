const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// Estado
let sock = null;
let qrCodeData = null;
let conectado = false;
let fila = [];
let disparando = false;
let pausado = false;
let logLines = [];
let stats = { total: 0, enviados: 0, erros: 0, pendentes: 0 };

function addLog(tipo, msg) {
  const hora = new Date().toLocaleTimeString('pt-BR');
  logLines.push({ hora, tipo, msg });
  if (logLines.length > 100) logLines.shift();
  console.log(`[${hora}] ${msg}`);
}

function delay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

function formatarNumero(num) {
  let n = String(num).replace(/\D/g, '');
  if (n.length === 11) n = '55' + n;
  if (n.length === 10) n = '55' + n;
  return n + '@s.whatsapp.net';
}

function personalizarMensagem(template, contato) {
  return template
    .replace(/\{nome\}/gi, contato.nome || '')
    .replace(/\{cpf\}/gi, contato.cpf || '')
    .replace(/\{telefone\}/gi, contato.telefone || '');
}

async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Bravo Consig', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 10000,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      conectado = false;
      addLog('info', '📱 QR Code gerado — escaneie no WhatsApp');
    }

    if (connection === 'open') {
      conectado = true;
      qrCodeData = null;
      addLog('ok', '✅ WhatsApp conectado com sucesso!');
    }

    if (connection === 'close') {
      conectado = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconectar = code !== DisconnectReason.loggedOut;
      addLog('erro', `❌ Desconectado (código ${code}). ${reconectar ? 'Reconectando...' : 'Sessão encerrada.'}`);
      if (reconectar) {
        setTimeout(conectarWhatsApp, 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function processarFila(mensagem) {
  disparando = true;
  pausado = false;

  for (let i = 0; i < fila.length; i++) {
    if (pausado) {
      addLog('info', '⏸ Disparo pausado.');
      break;
    }

    const contato = fila[i];
    if (contato.status !== 'pendente') continue;

    if (!conectado) {
      addLog('erro', '❌ WhatsApp desconectado. Pausando disparo.');
      break;
    }

    try {
      const numero = formatarNumero(contato.telefone);
      const texto = personalizarMensagem(mensagem, contato);
      await sock.sendMessage(numero, { text: texto });
      contato.status = 'enviado';
      stats.enviados++;
      stats.pendentes--;
      addLog('ok', `✅ ${contato.nome} (${contato.telefone})`);
    } catch (e) {
      contato.status = 'erro';
      contato.erro = e.message;
      stats.erros++;
      stats.pendentes--;
      addLog('erro', `❌ ${contato.nome} (${contato.telefone}) — ${e.message}`);
    }

    if (i < fila.length - 1 && !pausado) {
      await delay(8000, 15000);
    }
  }

  disparando = false;
  addLog('info', '🏁 Disparo finalizado!');
}

// Rotas
app.get('/qrcode', (req, res) => {
  res.json({ qr: qrCodeData, conectado });
});

app.get('/status', (req, res) => {
  res.json({ conectado, disparando, pausado, stats, log: logLines.slice(-50), fila: fila.slice(0, 200) });
});

app.post('/importar', upload.single('arquivo'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const getVal = (row, nomes) => {
      for (const n of nomes) {
        const k = Object.keys(row).find(k => k.toLowerCase().includes(n));
        if (k) return String(row[k]).trim();
      }
      return '';
    };

    const contatos = dados.map((row, i) => ({
      id: i,
      nome: getVal(row, ['nome', 'name']),
      cpf: getVal(row, ['cpf']),
      telefone: getVal(row, ['telefone', 'fone', 'celular', 'whatsapp', 'numero']),
      status: 'pendente',
      erro: ''
    })).filter(c => c.telefone.replace(/\D/g, '').length >= 10);

    fila = contatos;
    stats = { total: contatos.length, enviados: 0, erros: 0, pendentes: contatos.length };
    logLines = [];

    fs.unlinkSync(req.file.path);
    res.json({ ok: true, total: contatos.length, preview: contatos.slice(0, 5) });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.post('/disparar', (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem) return res.status(400).json({ ok: false, erro: 'Mensagem obrigatória' });
  if (!conectado) return res.status(400).json({ ok: false, erro: 'WhatsApp não conectado' });
  if (disparando) return res.status(400).json({ ok: false, erro: 'Já está disparando' });
  if (fila.length === 0) return res.status(400).json({ ok: false, erro: 'Importe uma planilha primeiro' });
  processarFila(mensagem);
  res.json({ ok: true });
});

app.post('/pausar', (req, res) => { pausado = true; res.json({ ok: true }); });

app.post('/reiniciar', (req, res) => {
  fila.forEach(c => { if (c.status !== 'enviado') { c.status = 'pendente'; c.erro = ''; } });
  stats.pendentes = fila.filter(c => c.status === 'pendente').length;
  stats.erros = 0;
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bravo Disparos</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0f0f0f;color:#f0f0f0;min-height:100vh}
.header{background:#1a1a2e;padding:16px 24px;display:flex;align-items:center;gap:12px;border-bottom:2px solid #25d366}
.header h1{font-size:20px;color:#25d366}
.badge{margin-left:auto;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700}
.connected{background:#25d36620;color:#25d366;border:1px solid #25d366}
.disconnected{background:#ff444420;color:#ff4444;border:1px solid #ff4444}
.container{max-width:860px;margin:0 auto;padding:20px 16px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:18px}
.card h2{font-size:13px;color:#888;margin-bottom:14px;text-transform:uppercase;letter-spacing:1px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.stat{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:14px;text-align:center}
.stat .num{font-size:26px;font-weight:700}
.stat .lbl{font-size:11px;color:#888;margin-top:3px}
.s-total .num{color:#fff}.s-env .num{color:#25d366}.s-err .num{color:#ff4444}.s-pen .num{color:#f0a500}
.btn{padding:10px 18px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;transition:.2s}
.btn-green{background:#25d366;color:#000}.btn-green:hover{background:#1db954}
.btn-red{background:#ff4444;color:#fff}.btn-gray{background:#333;color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.flex{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
textarea{width:100%;background:#111;border:1px solid #333;color:#f0f0f0;border-radius:8px;padding:12px;font-size:14px;resize:vertical;min-height:100px}
.log-box{background:#111;border:1px solid #222;border-radius:8px;padding:12px;height:180px;overflow-y:auto;font-size:13px;font-family:monospace}
.log-ok{color:#25d366}.log-erro{color:#ff4444}.log-info{color:#888}
.upload-area{border:2px dashed #333;border-radius:10px;padding:28px;text-align:center;cursor:pointer;transition:.2s}
.upload-area:hover{border-color:#25d366}
input[type=file]{display:none}
.tag{background:#25d36620;color:#25d366;border:1px solid #25d36640;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;margin-right:6px;margin-top:6px;display:inline-block}
.tag:hover{background:#25d36640}
.bar{height:6px;background:#222;border-radius:3px;margin-top:10px;overflow:hidden}
.bar-fill{height:100%;background:#25d366;border-radius:3px;transition:width .5s}
.info{background:#1a2a1a;border:1px solid #25d36640;border-radius:8px;padding:10px;font-size:12px;color:#aaa;margin-top:10px}
#qr-img{max-width:220px;margin:12px auto;display:block;border-radius:8px}
</style>
</head>
<body>
<div class="header">
  <span style="font-size:24px">💬</span>
  <h1>Bravo Disparos</h1>
  <span class="badge disconnected" id="badge">Verificando...</span>
</div>
<div class="container">

<div class="stats">
  <div class="stat s-total"><div class="num" id="s0">0</div><div class="lbl">Total</div></div>
  <div class="stat s-env"><div class="num" id="s1">0</div><div class="lbl">Enviados</div></div>
  <div class="stat s-err"><div class="num" id="s2">0</div><div class="lbl">Erros</div></div>
  <div class="stat s-pen"><div class="num" id="s3">0</div><div class="lbl">Pendentes</div></div>
</div>
<div class="bar"><div class="bar-fill" id="prog" style="width:0%"></div></div>

<div class="card" style="margin-top:18px">
  <h2>📱 Conexão WhatsApp</h2>
  <div class="flex">
    <button class="btn btn-green" onclick="verQR()">Ver QR Code</button>
    <span style="color:#888;font-size:13px">Escaneie com o WhatsApp do chip dedicado</span>
  </div>
  <div id="qr-area"></div>
</div>

<div class="card">
  <h2>📂 Importar Planilha</h2>
  <label for="arq">
    <div class="upload-area">
      <div style="font-size:36px">📊</div>
      <div style="margin-top:8px;font-size:15px">Clique para selecionar a planilha</div>
      <div style="color:#666;font-size:12px;margin-top:6px">Excel (.xlsx) ou CSV — colunas: Nome, Telefone, CPF</div>
    </div>
  </label>
  <input type="file" id="arq" accept=".xlsx,.xls,.csv" onchange="importar(this)">
  <div id="imp-result"></div>
</div>

<div class="card">
  <h2>✉️ Mensagem</h2>
  <textarea id="msg" placeholder="Digite sua mensagem...

Exemplo: Olá {nome}, temos uma proposta de crédito consignado liberada pra você! Quer saber mais?"></textarea>
  <div>
    <span class="tag" onclick="ins('{nome}')">+ nome</span>
    <span class="tag" onclick="ins('{cpf}')">+ cpf</span>
    <span class="tag" onclick="ins('{telefone}')">+ telefone</span>
  </div>
</div>

<div class="card">
  <h2>🚀 Controles</h2>
  <div class="flex">
    <button class="btn btn-green" onclick="disparar()">▶ Iniciar Disparo</button>
    <button class="btn btn-red" id="btn-pausar" onclick="pausar()" disabled>⏸ Pausar</button>
    <button class="btn btn-gray" onclick="reiniciar()">🔄 Reiniciar Erros</button>
  </div>
  <div class="info">⚠️ Envia 1 mensagem a cada 8–15 segundos. Recomendado: máximo 300/dia na primeira semana.</div>
</div>

<div class="card">
  <h2>📋 Log em Tempo Real</h2>
  <div class="log-box" id="log"></div>
</div>

</div>
<script>
let logLen = 0;

function ins(t){const e=document.getElementById('msg');const p=e.selectionStart;e.value=e.value.slice(0,p)+t+e.value.slice(e.selectionEnd);e.focus()}

async function verQR(){
  const a=document.getElementById('qr-area');
  a.innerHTML='<div style="color:#888;margin-top:12px">Carregando...</div>';
  const d=await fetch('/qrcode').then(r=>r.json());
  if(d.conectado){a.innerHTML='<div style="color:#25d366;margin-top:12px;font-size:15px">✅ WhatsApp conectado!</div>';}
  else if(d.qr){a.innerHTML='<img id="qr-img" src="'+d.qr+'"><div style="text-align:center;color:#888;font-size:12px">Escaneie com o WhatsApp</div>';}
  else{a.innerHTML='<div style="color:#888;margin-top:12px">Aguardando QR Code... clique novamente em alguns segundos.</div>';}
}

async function importar(i){
  const f=i.files[0];if(!f)return;
  const fd=new FormData();fd.append('arquivo',f);
  document.getElementById('imp-result').innerHTML='<div style="color:#888;margin-top:10px">Importando...</div>';
  const d=await fetch('/importar',{method:'POST',body:fd}).then(r=>r.json());
  document.getElementById('imp-result').innerHTML=d.ok
    ?'<div style="color:#25d366;margin-top:10px">✅ '+d.total+' contatos importados! Prévia: '+d.preview.map(c=>c.nome||c.telefone).join(', ')+'...</div>'
    :'<div style="color:#ff4444;margin-top:10px">❌ '+d.erro+'</div>';
}

async function disparar(){
  const m=document.getElementById('msg').value.trim();
  if(!m)return alert('Digite a mensagem!');
  if(!confirm('Confirma o disparo para todos os contatos?'))return;
  const d=await fetch('/disparar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:m})}).then(r=>r.json());
  if(!d.ok)alert('Erro: '+d.erro);
  else document.getElementById('btn-pausar').disabled=false;
}

async function pausar(){await fetch('/pausar',{method:'POST'});document.getElementById('btn-pausar').disabled=true;}
async function reiniciar(){await fetch('/reiniciar',{method:'POST'});}

async function atualizar(){
  const d=await fetch('/status').then(r=>r.json()).catch(()=>null);
  if(!d)return;
  document.getElementById('s0').textContent=d.stats.total;
  document.getElementById('s1').textContent=d.stats.enviados;
  document.getElementById('s2').textContent=d.stats.erros;
  document.getElementById('s3').textContent=d.stats.pendentes;
  const pct=d.stats.total>0?Math.round(d.stats.enviados/d.stats.total*100):0;
  document.getElementById('prog').style.width=pct+'%';
  const b=document.getElementById('badge');
  b.textContent=d.conectado?'✅ Conectado':'❌ Desconectado';
  b.className='badge '+(d.conectado?'connected':'disconnected');
  if(d.log.length!==logLen){
    const box=document.getElementById('log');
    box.innerHTML=d.log.map(l=>'<div class="log-'+l.tipo+'">['+l.hora+'] '+l.msg+'</div>').join('');
    box.scrollTop=box.scrollHeight;
    logLen=d.log.length;
  }
}

setInterval(atualizar,2000);
atualizar();
</script>
</body>
</html>`);
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Bravo Disparos rodando em: http://localhost:${PORT}\n`);
  conectarWhatsApp();
});
