const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const fs = require('fs');
const https = require('https');
const path = require('path');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');


// Carregar .env se existir
try {
  const envFile = require('fs').readFileSync('.env', 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  });
} catch(e) {}

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

// Agente IA
let ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const NUMERO_MARCELO = process.env.NUMERO_MARCELO || ''; // ex: 5577991234567
const conversas = {}; // { numero: { etapa, dados, historico } }

function respostaAutomatica(texto, conv) {
  const t = texto.toLowerCase().trim();
  const etapa = conv.etapa || 'inicio';
  const nome = conv.dados.nome || '';
  const primeiroNome = nome.split(' ')[0] || '';

  const hora = new Date().getHours();
  const saudacao = hora < 12 ? 'Bom Dia!' : hora < 18 ? 'Boa Tarde!' : 'Boa Noite!';

  if (etapa === 'inicio') {
    conv.etapa = 'aguardar_resposta';
    if (primeiroNome) {
      return saudacao + '\n' + primeiroNome + '.\n\nTudo Bem?';
    }
    return saudacao + '\n\nTudo Bem?';
  }

  if (etapa === 'aguardar_resposta') {
    conv.etapa = 'pedir_cpf';
    return 'Para verificar as oportunidades disponíveis para você, pode me informar seu *CPF*?';
  }

  if (etapa === 'pedir_cpf') {
    const cpfLimpo = texto.replace(/\D/g, '');
    if (cpfLimpo.length === 11) {
      conv.dados.cpf = cpfLimpo;
      conv.etapa = 'encerrado';
      conv.qualificado = true;
      return 'Perfeito! ✅\n\nJá estamos verificando as oportunidades disponíveis para você.\n\nEm breve nosso analista entrará em contato com as melhores opções! 😊';
    }
    if (cpfLimpo.length > 0) {
      return 'Por gentileza, informe o CPF completo com 11 dígitos 😊';
    }
    return 'Para verificar as oportunidades disponíveis, pode me informar seu *CPF*?';
  }

  if (etapa === 'encerrado') {
    return 'Nosso analista já está verificando sua situação e entrará em contato em breve! 😊';
  }

  return saudacao + '\n\nComo posso te ajudar?';
}

async function chamarGemini(historico, systemPrompt) {
  const key = ANTHROPIC_KEY || process.env.ANTHROPIC_KEY;
  if (!key) return null;

  const contents = historico.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const bodyObj = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: contents,
    generationConfig: { maxOutputTokens: 400, temperature: 0.8 }
  };

  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(bodyObj);
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
    url.searchParams.set('key', key);
    
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (!text && d.error) addLog('erro', 'Gemini erro: ' + d.error.message);
          resolve(text || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(bodyStr);
    req.end();
  });
}

function simularCredito(dados) {
  const { tipo, salario } = dados;
  let margem = 0;
  let taxaMensal = 0.0179;
  
  if (tipo === 'inss') {
    margem = salario * 0.35;
    taxaMensal = 0.0179;
  } else if (tipo === 'servidor') {
    margem = salario * 0.30;
    taxaMensal = 0.0159;
  } else {
    margem = salario * 0.30;
    taxaMensal = 0.0199;
  }
  
  const prazo = 84;
  const fator = (taxaMensal * Math.pow(1 + taxaMensal, prazo)) / (Math.pow(1 + taxaMensal, prazo) - 1);
  const valorLiberado = margem / fator;
  
  return {
    margem: margem.toFixed(2),
    valorLiberado: valorLiberado.toFixed(2),
    parcela: margem.toFixed(2),
    prazo,
    taxa: (taxaMensal * 100).toFixed(2)
  };
}

const SYSTEM_PROMPT = `Você é Ben, consultor de crédito consignado da Bravo Consig, em Bahia, Brasil.
Seu objetivo é qualificar leads, fazer simulações e agendar atendimento com Marcelo.

FLUXO:
1. Cumprimente e pergunte o nome
2. Pergunte se é aposentado/pensionista INSS, servidor público ou CLT
3. Pergunte o valor do benefício/salário
4. Apresente a simulação de crédito
5. Pergunte se quer agendar com Marcelo

REGRAS:
- Seja simpático, informal mas profissional
- Respostas curtas (máximo 3 linhas)
- Nunca mencione taxa de juros a menos que perguntado
- Sempre foque no valor que a pessoa vai receber na mão
- Se a pessoa disser que não tem interesse, agradeça e encerre
- Não invente informações

Quando tiver todos os dados (nome, tipo, salário), inclua no fim da resposta a tag: [LEAD_QUALIFICADO]`;

async function processarMensagemAgente(numero, texto) {
  if (!ANTHROPIC_KEY) return null;
  
  if (!conversas[numero]) {
    conversas[numero] = { historico: [], dados: {}, qualificado: false };
  }
  
  const conv = conversas[numero];
  conv.historico.push({ role: 'user', content: texto });
  
  // Extrair dados mencionados
  const textoLower = texto.toLowerCase();
  if (textoLower.includes('inss') || textoLower.includes('aposentad') || textoLower.includes('pensionist')) {
    conv.dados.tipo = 'inss';
  } else if (textoLower.includes('servidor') || textoLower.includes('funcionário') || textoLower.includes('prefeitura') || textoLower.includes('estado')) {
    conv.dados.tipo = 'servidor';
  } else if (textoLower.includes('clt') || textoLower.includes('empregad') || textoLower.includes('empresa')) {
    conv.dados.tipo = 'clt';
  }
  
  const valorMatch = texto.match(/R?\$?\s*(\d[\d.,]+)/);
  if (valorMatch) {
    const val = parseFloat(valorMatch[1].replace(/\./g, '').replace(',', '.'));
    if (val > 500 && val < 50000) conv.dados.salario = val;
  }
  
  // Se tiver dados suficientes, incluir simulação no contexto
  let contextoSimulacao = '';
  if (conv.dados.tipo && conv.dados.salario) {
    const sim = simularCredito(conv.dados);
    contextoSimulacao = `\n\nDADOS DO LEAD: tipo=${conv.dados.tipo}, salário=R$${conv.dados.salario}\nSIMULAÇÃO: Pode liberar R$${sim.valorLiberado} em ${sim.prazo}x de R$${sim.parcela}`;
  }
  
  // Tentar Gemini, fallback para resposta automática
  let resposta = null;
  const key = ANTHROPIC_KEY || process.env.ANTHROPIC_KEY;
  if (key) {
    try { resposta = await chamarGemini(conv.historico, SYSTEM_PROMPT + contextoSimulacao); } catch(e) {}
  }
  if (!resposta) resposta = respostaAutomatica(texto, conv);
  
  // Verificar se lead foi qualificado
  if (resposta.includes('[LEAD_QUALIFICADO]') && !conv.qualificado) {
    conv.qualificado = true;
    const sim = conv.dados.salario ? simularCredito(conv.dados) : null;
    const msg = `🔥 *LEAD QUALIFICADO*\n\nNúmero: ${numero.replace('@s.whatsapp.net', '')}\nTipo: ${conv.dados.tipo || 'N/I'}\nSalário: R$${conv.dados.salario || 'N/I'}${sim ? '\nValor a liberar: R$' + sim.valorLiberado : ''}\n\nVeja a conversa no painel.`;
    
    if (NUMERO_MARCELO && sock) {
      sock.sendMessage(formatarNumero(NUMERO_MARCELO), { text: msg }).catch(() => {});
    }
    addLog('ok', `🔥 Lead qualificado: ${numero}`);
  }
  
  const respostaLimpa = resposta.replace('[LEAD_QUALIFICADO]', '').trim();
  conv.historico.push({ role: 'assistant', content: respostaLimpa });
  
  // Limitar histórico
  if (conv.historico.length > 20) conv.historico = conv.historico.slice(-20);
  
  return respostaLimpa;
}


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

  // Receber mensagens e acionar agente
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      const numero = msg.key.remoteJid;
      if (numero.includes('g.us')) continue; // ignorar grupos
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!texto) continue;
      
      addLog('info', `📨 Mensagem de ${numero.replace('@s.whatsapp.net','')}: ${texto.substring(0,40)}`);
      
      try {
        const resposta = await processarMensagemAgente(numero, texto);
        if (resposta && sock) {
          await delay(1500, 3000);
          await sock.sendMessage(numero, { text: resposta });
          addLog('ok', `🤖 Agente respondeu ${numero.replace('@s.whatsapp.net','')}`);
        }
      } catch(e) {
        addLog('erro', `❌ Erro agente: ${e.message}`);
      }
    }
  });

}

const LIMITE_DIARIO = 200;
let enviadosHoje = 0;
let dataHoje = new Date().toDateString();

function dentroHorarioComercial() {
  const agora = new Date();
  const hora = agora.getHours();
  return hora >= 8 && hora < 18;
}

function resetarContadorDiario() {
  const hoje = new Date().toDateString();
  if (hoje !== dataHoje) {
    dataHoje = hoje;
    enviadosHoje = 0;
  }
}

async function esperarHorarioComercial() {
  while (!dentroHorarioComercial()) {
    const agora = new Date();
    const hora = agora.getHours();
    if (hora >= 18) {
      addLog('info', '🌙 Fora do horário. Disparos retomam às 08h.');
    }
    await delay(60000, 60000); // checar a cada 1 min
    if (pausado) return;
  }
}

async function processarFila(mensagem) {
  disparando = true;
  pausado = false;
  let contadorSessao = 0;

  for (let i = 0; i < fila.length; i++) {
    if (pausado) {
      addLog('info', '⏸ Disparo pausado pelo usuário.');
      break;
    }

    // Checar horário comercial
    await esperarHorarioComercial();
    if (pausado) break;

    // Checar limite diário
    resetarContadorDiario();
    if (enviadosHoje >= LIMITE_DIARIO) {
      addLog('info', '📊 Limite diário de ' + LIMITE_DIARIO + ' mensagens atingido. Retomando amanhã às 08h.');
      await esperarHorarioComercial();
      resetarContadorDiario();
      if (enviadosHoje >= LIMITE_DIARIO) break;
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

      // Simular "digitando..." antes de enviar
      await sock.sendPresenceUpdate('composing', numero);
      const tempoDigitando = Math.floor(Math.random() * 4000) + 2000; // 2-6 segundos digitando
      await delay(tempoDigitando, tempoDigitando);
      await sock.sendPresenceUpdate('paused', numero);

      await sock.sendMessage(numero, { text: texto });
      contato.status = 'enviado';
      stats.enviados++;
      stats.pendentes--;
      enviadosHoje++;
      contadorSessao++;
      addLog('ok', '✅ ' + (contato.nome||contato.telefone) + ' (' + enviadosHoje + '/' + LIMITE_DIARIO + ' hoje)');
    } catch (e) {
      contato.status = 'erro';
      contato.erro = e.message;
      stats.erros++;
      stats.pendentes--;
      addLog('erro', '❌ ' + (contato.nome||contato.telefone) + ' — ' + e.message);
    }

    if (i < fila.length - 1 && !pausado) {
      // A cada 10 mensagens, pausa longa (5-10 min)
      if (contadorSessao > 0 && contadorSessao % 10 === 0) {
        const pausaMin = Math.floor(Math.random() * 5) + 5;
        addLog('info', '☕ Pausa humana de ' + pausaMin + ' minutos após 10 envios...');
        await delay(pausaMin * 60000, pausaMin * 60000);
      } else {
        // Intervalo humano: 45 segundos a 3 minutos
        const minSeg = 45;
        const maxSeg = 180;
        const segundos = Math.floor(Math.random() * (maxSeg - minSeg)) + minSeg;
        addLog('info', '⏳ Próximo envio em ' + segundos + 's...');
        await delay(segundos * 1000, segundos * 1000);
      }
    }
  }

  disparando = false;
  addLog('info', '🏁 Disparo finalizado! Total hoje: ' + enviadosHoje);
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

app.post('/enviar-avulso', async (req, res) => {
  const { telefone, mensagem } = req.body;
  if (!telefone || !mensagem) return res.status(400).json({ ok: false, erro: 'Telefone e mensagem obrigatórios' });
  if (!conectado) return res.status(400).json({ ok: false, erro: 'WhatsApp não conectado' });
  try {
    const numero = formatarNumero(telefone);
    await sock.sendMessage(numero, { text: mensagem });
    addLog('ok', `✅ Avulso enviado para ${telefone}`);
    res.json({ ok: true });
  } catch (e) {
    addLog('erro', `❌ Erro avulso ${telefone}: ${e.message}`);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.post('/reiniciar', (req, res) => {
  fila.forEach(c => { if (c.status !== 'enviado') { c.status = 'pendente'; c.erro = ''; } });
  stats.pendentes = fila.filter(c => c.status === 'pendente').length;
  stats.erros = 0;
  res.json({ ok: true });
});


app.get('/leads', (req, res) => {
  const leads = Object.entries(conversas).map(([num, conv]) => ({
    numero: num.replace('@s.whatsapp.net', ''),
    qualificado: conv.qualificado,
    dados: conv.dados,
    mensagens: conv.historico.length
  }));
  res.json({ leads });
});

app.post('/config-agente', (req, res) => {
  const { key, numeroMarcelo } = req.body;
  if (key) { process.env.ANTHROPIC_KEY = key; ANTHROPIC_KEY = key; }
  if (numeroMarcelo) { process.env.NUMERO_MARCELO = numeroMarcelo; }
  res.json({ ok: true });
});

app.delete('/conversa/:numero', (req, res) => {
  const num = req.params.numero + '@s.whatsapp.net';
  delete conversas[num];
  res.json({ ok: true });
});


app.post('/gerar-mensagem', async (req, res) => {
  const { nome } = req.body || {};
  const key = ANTHROPIC_KEY || process.env.ANTHROPIC_KEY;

  // Templates variados para servidores públicos da Bahia
  const templates = [
    'Olá {nome}! 👋 Sou o Ben, analista da Bravo Consig. Como servidor público da Bahia, você pode ter margem disponível para crédito consignado. Posso verificar quanto está liberado pra você?',
    'Oi {nome}! 😊 Aqui é o Ben da Bravo Consig. Temos condições especiais de crédito consignado para servidores do Estado da Bahia. Quer saber quanto você tem disponível?',
    '{nome}, bom dia! Sou analista da Bravo Consig 👋 Identificamos que você pode ter crédito consignado disponível. Parcelas no contracheque, sem burocracia. Posso verificar pra você?',
    'Olá {nome}! Aqui é o Ben da Bravo Consig. Muitos servidores da Bahia estão aproveitando nossas condições de crédito consignado. Posso verificar sua margem disponível agora?',
    '{nome}, tudo bem? 😊 Ben aqui, da Bravo Consig. Como servidor público, você tem direito às menores taxas de consignado. Quer que eu verifique quanto está liberado no seu contracheque?',
    'Oi {nome}! Sou o Ben, da Bravo Consig 👋 Tenho uma proposta de crédito consignado para servidores da Bahia. Sem consulta ao SPC, desconto direto na folha. Posso te passar os detalhes?',
    '{nome}, olá! Aqui é o Ben da Bravo Consig. Servidores públicos da Bahia podem ter até R$50mil em crédito consignado disponível. Quer saber o seu limite?',
    'Olá {nome}! 😊 Ben aqui, analista da Bravo Consig. Temos aprovação rápida de crédito consignado para servidores do Estado. Posso verificar sua situação agora mesmo?'
  ];

  // Tentar gerar com Gemini se tiver chave
  if (key && nome) {
    try {
      const prompt = 'Crie UMA mensagem de WhatsApp curta (maximo 2 linhas) para prospeccao de credito consignado para servidor publico da Bahia chamado ' + nome + '. Seja natural, humano, informal mas profissional. Assine como Ben da Bravo Consig. Use 1 emoji no maximo. Termine com uma pergunta que convide a responder. Nao mencione taxas.';
      
      const bodyStr = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 150, temperature: 0.9 }
      });

      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
      url.searchParams.set('key', key);

      const geminiResp = await new Promise((resolve) => {
        const req2 = https.request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
        }, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => {
            try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
          });
        });
        req2.on('error', () => resolve(null));
        req2.write(bodyStr); req2.end();
      });

      const texto = geminiResp?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (texto && texto.length > 10) {
        return res.json({ ok: true, mensagem: texto.trim(), fonte: 'gemini' });
      }
    } catch(e) {}
  }

  // Fallback: template aleatório
  const idx = Math.floor(Math.random() * templates.length);
  const nomeUsar = nome || '{nome}';
  const mensagem = templates[idx].replace(/{nome}/g, nomeUsar);
  res.json({ ok: true, mensagem, fonte: 'template' });
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
<div class="card">
  <h2>📤 Envio Avulso</h2>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
    <input id="av-tel" type="text" placeholder="Telefone (ex: 77991234567)" style="flex:1;min-width:180px;background:#111;border:1px solid #333;color:#f0f0f0;border-radius:8px;padding:10px;font-size:14px">
  </div>
  <textarea id="av-msg" placeholder="Mensagem avulsa..." style="width:100%;background:#111;border:1px solid #333;color:#f0f0f0;border-radius:8px;padding:10px;font-size:14px;resize:vertical;min-height:70px;margin-bottom:10px"></textarea>
  <button class="btn btn-green" onclick="enviarAvulso()">📤 Enviar Agora</button>
  <div id="av-result" style="margin-top:8px;font-size:13px"></div>
</div>


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
  <textarea id="msg" placeholder="Digite sua mensagem ou clique em Gerar Mensagem..."></textarea>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
    <button class="btn btn-green" onclick="gerarMensagem()" style="padding:8px 14px;font-size:13px">✨ Gerar Mensagem</button>
    <span class="tag" onclick="ins('{nome}')">+ nome</span>
    <span class="tag" onclick="ins('{cpf}')">+ cpf</span>
    <span class="tag" onclick="ins('{telefone}')">+ telefone</span>
  </div>
  <div id="gerar-status" style="font-size:12px;color:#888;margin-top:6px"></div>
</div>

<div class="card">
  
<div class="card">
  <h2>🤖 Agente IA (Ben)</h2>
  <div id="agente-status" style="margin-bottom:12px;padding:10px;background:#111;border-radius:8px;font-size:13px;color:#888">
    Configure a API Key para ativar o agente
  </div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
    <input id="ag-key" type="password" placeholder="Google Gemini API Key" style="flex:2;min-width:200px;background:#111;border:1px solid #333;color:#f0f0f0;border-radius:8px;padding:10px;font-size:13px">
    <input id="ag-num" type="text" placeholder="Seu número (ex: 5577991234567)" style="flex:1;min-width:160px;background:#111;border:1px solid #333;color:#f0f0f0;border-radius:8px;padding:10px;font-size:13px">
    <button class="btn btn-green" onclick="salvarAgente()">💾 Ativar</button>
  </div>
  <div style="font-size:12px;color:#666;margin-bottom:14px">
    Quando alguém responder o disparo, o Ben responde automaticamente, qualifica o lead e te avisa no WhatsApp.
  </div>
  <h2 style="margin-bottom:10px">🔥 Leads Qualificados</h2>
  <div id="leads-lista" style="font-size:13px;color:#888">Nenhum lead ainda.</div>
  <button class="btn btn-gray" onclick="verLeads()" style="margin-top:10px">🔄 Atualizar Leads</button>
</div>
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


async function gerarMensagem(){
  const status = document.getElementById('gerar-status');
  status.textContent = 'Gerando mensagem...';
  const d = await fetch('/gerar-mensagem', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({nome: '{nome}'})
  }).then(r => r.json());
  if (d.ok) {
    document.getElementById('msg').value = d.mensagem;
    status.textContent = d.fonte === 'gemini' ? '✅ Gerado com IA' : '✅ Gerado automaticamente';
  }
}

async function enviarAvulso(){
  const tel=document.getElementById('av-tel').value.trim();
  const msg=document.getElementById('av-msg').value.trim();
  const res=document.getElementById('av-result');
  if(!tel||!msg)return res.innerHTML='<span style="color:#ff4444">Preencha telefone e mensagem</span>';
  res.innerHTML='<span style="color:#888">Enviando...</span>';
  const d=await fetch('/enviar-avulso',{method:'POST',headers:{"Content-Type":"application/json"},body:JSON.stringify({telefone:tel,mensagem:msg})}).then(r=>r.json());
  res.innerHTML=d.ok?'<span style="color:#25d366">✅ Enviado!</span>':'<span style="color:#ff4444">❌ '+d.erro+'</span>';
}

async function salvarAgente(){
  const key=document.getElementById('ag-key').value.trim();
  const num=document.getElementById('ag-num').value.trim();
  if(!key)return alert('Digite a API Key');
  const d=await fetch('/config-agente',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,numeroMarcelo:num})}).then(r=>r.json());
  if(d.ok){
    document.getElementById('agente-status').innerHTML='<span style="color:#25d366">✅ Agente Ben ativado! Responde automaticamente quem enviar mensagem.</span>';
  }
}

async function verLeads(){
  const d=await fetch('/leads').then(r=>r.json());
  const box=document.getElementById('leads-lista');
  if(!d.leads||!d.leads.length){box.innerHTML='<span style="color:#888">Nenhum lead ainda.</span>';return;}
  let html='';
  d.leads.forEach(function(l){
    const cor=l.qualificado?'#25d366':'#333';
    const corNome=l.qualificado?'#25d366':'#fff';
    const badge=l.qualificado?' 🔥 QUALIFICADO':'';
    const dados=l.dados.tipo?('<div style="color:#aaa;font-size:12px;margin-top:4px">Tipo: '+l.dados.tipo+(l.dados.salario?' | Salário: R$'+l.dados.salario:'')+'</div>'):'';
    html+='<div style="background:#111;border:1px solid '+cor+';border-radius:8px;padding:12px;margin-bottom:8px">';
    html+='<div style="display:flex;justify-content:space-between;align-items:center">';
    html+='<span style="font-weight:700;color:'+corNome+'">'+l.numero+badge+'</span>';
    html+='<span style="color:#666;font-size:11px">'+l.mensagens+' mensagens</span>';
    html+='</div>'+dados+'</div>';
  });
  box.innerHTML=html;
}

setInterval(verLeads, 10000);
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
