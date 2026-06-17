const fs = require('fs');
const https = require('https');

// Baixar o arquivo correto do GitHub via API (não raw, para evitar cache)
const TOKEN = '';
const options = {
  hostname: 'api.github.com',
  path: '/repos/marcelocerqueiralp-cmyk/bravo-disparos/contents/server.js',
  headers: {
    'User-Agent': 'node',
    'Accept': 'application/vnd.github.v3.raw'
  }
};

console.log('Baixando server.js correto...');
https.get(options, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    // Se veio JSON com base64, decodificar
    try {
      const json = JSON.parse(data);
      if (json.content) {
        data = Buffer.from(json.content, 'base64').toString('utf8');
      }
    } catch(e) {}
    
    // Verificar se tem o agente
    if (!data.includes('processarMensagemAgente')) {
      console.log('ERRO: arquivo não tem o agente. Aplicando patch...');
      
      // Aplicar patch no arquivo existente
      let atual = fs.readFileSync('server.js', 'utf8');
      
      // Corrigir a função verLeads
      const inicio = atual.indexOf('box.innerHTML=d.leads.map');
      const fim = atual.indexOf("}).join('');", inicio) + 11;
      
      if (inicio > 0 && fim > inicio) {
        const novaFuncao = `box.innerHTML=(function(leads){
  var html='';
  leads.forEach(function(l){
    var cor=l.qualificado?'#25d366':'#333';
    var cn=l.qualificado?'#25d366':'#fff';
    var b=l.qualificado?' QUALIFICADO':'';
    var dd=l.dados&&l.dados.tipo?('<div style="font-size:11px;color:#aaa">'+l.dados.tipo+(l.dados.salario?' | R$'+l.dados.salario:'')+'</div>'):'';
    html+='<div style="background:#111;border:1px solid '+cor+';border-radius:8px;padding:10px;margin-bottom:6px">';
    html+='<b style="color:'+cn+'">'+l.numero+b+'</b>';
    html+=' <span style="color:#666;font-size:11px">('+l.mensagens+' msgs)</span>';
    html+=dd+'</div>';
  });
  return html;
})(d.leads)`;
        
        atual = atual.slice(0, inicio) + novaFuncao + atual.slice(fim);
        fs.writeFileSync('server.js', atual);
        console.log('Patch aplicado! Tamanho:', atual.length);
      } else {
        console.log('Posição não encontrada:', inicio, fim);
      }
    } else {
      fs.writeFileSync('server.js', data);
      console.log('Arquivo atualizado! Tamanho:', data.length);
    }
    
    // Verificar sintaxe
    const { execSync } = require('child_process');
    try {
      execSync('node --check server.js', { stdio: 'inherit' });
      console.log('SINTAXE OK! Execute: node server.js');
    } catch(e) {
      console.log('ERRO DE SINTAXE - verifique o arquivo');
    }
  });
}).on('error', e => console.log('Erro download:', e.message));
