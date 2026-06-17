const fs = require('fs');
let c = fs.readFileSync('server.js', 'utf8');

// Corrigir URL encoding
const antes = c.includes('encodeURIComponent');
if (!antes) {
  c = c.replace(
    "generateContent?key=' + ANTHROPIC_KEY",
    "generateContent?key=' + encodeURIComponent(ANTHROPIC_KEY)"
  );
  fs.writeFileSync('server.js', c);
  console.log('Corrigido! encodeURIComponent adicionado.');
} else {
  console.log('Já está correto. Verificando outros problemas...');
}

// Verificar se o path está sendo construído corretamente
const match = c.match(/const path = .+generateContent.+/);
if (match) console.log('Path atual:', match[0]);

// Verificar se a função está sendo chamada
const temChamada = c.includes('chamarGemini');
console.log('Função chamarGemini presente:', temChamada);

// Verificar sintaxe
const { execSync } = require('child_process');
try {
  execSync('node --check server.js');
  console.log('Sintaxe OK');
} catch(e) {
  console.log('Erro sintaxe:', e.message);
}
