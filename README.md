# Bravo Disparos — Sistema de Disparo WhatsApp

## O que é isso?
Sistema completo de disparo de WhatsApp via Evolution API.
Importa planilha Excel com Nome, CPF e Telefone e dispara mensagem personalizada.

## Passo a Passo de Deploy

### 1. Criar conta na Evolution API (GRATUITO)
Acesse: https://evolution-api.com
Ou use uma instância pública gratuita como: https://api.evoapicloud.com

### 2. Criar instância
- Após criar conta, crie uma instância chamada "bravo"
- Anote a URL e a API Key

### 3. Subir no Render (GRATUITO)
- Acesse: https://render.com
- New → Web Service
- Conecte o repositório GitHub com este código
- Configure as variáveis de ambiente:
  - EVOLUTION_URL = URL da sua Evolution API
  - EVOLUTION_KEY = sua API Key
  - INSTANCE_NAME = bravo

### 4. Usar
- Abra a URL do seu serviço no Render
- Clique em "Ver QR Code"
- Escaneie com o WhatsApp do chip dedicado
- Importe sua planilha Excel
- Digite a mensagem (use {nome} para personalizar)
- Clique em Iniciar Disparo

## Colunas da Planilha
O sistema detecta automaticamente colunas com:
- Nome / name
- Telefone / celular / fone / whatsapp / numero
- CPF

## Proteção Anti-Ban
O sistema espera entre 8 e 15 segundos entre cada mensagem.
Recomendação: não disparar mais de 500 por dia nos primeiros 7 dias.
