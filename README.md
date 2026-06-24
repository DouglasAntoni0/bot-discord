# Bot Discord - Sistema de Logs

Bot de Discord em TypeScript com discord.js v14 para registrar eventos de voz, mensagens apagadas, mensagens editadas e limpeza automática do canal de logs.

## Funcionalidades

### Logs de voz
- Entrada em canal de voz.
- Saída de canal de voz.
- Movimento entre canais.
- Desconexão ou movimento por moderador quando o Audit Log permite correlacionar.
- Quando o Discord não expõe alvo exato em eventos de voz, o bot marca o responsável como `provável`, não como confirmado.

### Logs de mensagens
- Mensagens apagadas com autor, canal, ID, conteúdo disponível e anexos.
- Mensagens parciais são registradas sem inventar autor ou conteúdo quando não estavam no cache.
- Identificação de moderador por Audit Log com nível de confiança: `confirmado`, `provável` ou `não identificado`.
- Bulk delete com canal, quantidade e responsável quando identificável.
- Mensagens editadas com antes/depois, autor, canal, ID e link direto.

### Proteção do canal de logs
- Se uma log enviada pelo bot for apagada, o bot registra um alerta.
- Alertas apagados não geram loop.
- Logs apagadas pela limpeza automática são ignoradas pela proteção.

### Limpeza automática
- Remove mensagens antigas do próprio bot no canal de logs.
- Retenção configurável por `LOG_RETENTION_DAYS`.
- Evita execuções sobrepostas.
- Usa rastreamento com TTL por mensagem para não limpar o estado inteiro de proteção.

## Configuração

Crie um arquivo `.env` na raiz do projeto:

```env
DISCORD_TOKEN=seu_token_aqui
LOG_CHANNEL_ID=123456789012345678
LOG_CHANNEL_NAME=📜logs
LOG_RETENTION_DAYS=5
```

`LOG_CHANNEL_ID` é a forma recomendada, porque continua funcionando mesmo se o canal for renomeado. Se ele ficar vazio, o bot procura por `LOG_CHANNEL_NAME` e alguns nomes comuns como `logs`, `📜-logs` e `📜│logs`.

`LOG_RETENTION_DAYS` aceita valores de 1 a 90. Se ficar vazio, o padrão é 5 dias.

## Permissões necessárias

No servidor/canal de logs, o bot precisa de:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- View Audit Log
- Manage Messages, apenas para a limpeza automática

No Discord Developer Portal, habilite os intents privilegiados necessários:

- Server Members Intent
- Message Content Intent

## Como rodar

```bash
npm install
npm run build
npm start
```

Para desenvolvimento:

```bash
npm run dev
```

## Scripts

- `npm run build`: compila TypeScript para `dist/`.
- `npm start`: executa `dist/index.js`.
- `npm run dev`: executa `src/index.ts` com `ts-node`.

## Observações sobre o Audit Log

O Discord nem sempre informa o alvo exato de todos os eventos. Por isso, o bot não assume que qualquer entrada recente do Audit Log pertence ao evento atual.

A regra agora é:

- `confirmado`: tipo, alvo quando disponível, janela de tempo e executor único bateram.
- `provável`: o Discord não expôs alvo exato, mas há entrada recente compatível com executor único.
- `não identificado`: não houve evidência suficiente ou havia candidatos concorrentes.

Essa política reduz acusações falsas e deixa claro quando o bot está inferindo.

## Deploy na Discloud

O projeto inclui `discloud.config` e usa `dist/index.js` como arquivo principal.

Configure o segredo `DISCORD_TOKEN` no painel da Discloud. Se possível, configure também `LOG_CHANNEL_ID` e `LOG_RETENTION_DAYS`.

## Segurança

- `.env` está no `.gitignore`.
- Nunca compartilhe o token do bot.
- Se o token for exposto, regenere no Discord Developer Portal.
