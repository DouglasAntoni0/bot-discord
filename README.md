# 🤖 Bot Discord — Sistema de Logs

Bot de Discord feito em **TypeScript** com **discord.js v14** para registrar eventos do servidor em um canal de logs.

---

## 📋 Funcionalidades

### 🎙️ Logs de Voice Chat
- **Entrada** — registra quem entrou em um canal de voz
- **Saída** — registra quem saiu de um canal de voz
- **Desconectado** — detecta se alguém foi desconectado por um moderador
- **Movido** — registra quando alguém troca de canal (sozinho ou movido por mod)

### 📋 Logs de Mensagens Deletadas
- Mostra **autor**, **canal** e **conteúdo** da mensagem deletada
- Identifica se foi apagada pelo **próprio autor** ou por um **moderador**
- Registra **anexos** que estavam na mensagem
- Suporta **deleção em massa** (bulk delete)

### ✏️ Logs de Mensagens Editadas
- Mostra conteúdo **antes** e **depois** da edição (em blocos de código)
- Mostra **autor**, **canal**, **ID da mensagem** e **data de criação**
- Link direto para a mensagem editada
- Footer com quem editou

---

## 🔍 Detecção Robusta do Audit Log

O bot usa um sistema robusto para identificar quem realizou cada ação:

- **5 tentativas** com backoff progressivo (800ms, 1600ms, 2400ms, 3200ms)
- **Janela de 30 segundos** para capturar entradas do audit log
- **Busca em dupla passagem** — primeiro por ID do alvo, depois fallback genérico
- **10 entradas** analisadas por tentativa
- Delay inicial antes de consultar (1500ms para mensagens, 500ms para voice)

---

## ⚙️ Configuração

### 1. Discord Developer Portal

1. Acesse [discord.com/developers/applications](https://discord.com/developers/applications)
2. Crie uma nova Application ou selecione a existente
3. Vá em **Bot** → copie o **Token**
4. Em **Privileged Gateway Intents**, habilite:
   - ✅ **Presence Intent**
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent**

### 2. Variável de Ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
DISCORD_TOKEN=seu_token_aqui
```

Ou configure a variável de ambiente `DISCORD_TOKEN` no seu serviço de hospedagem.

### 3. Canal de Logs

Crie um canal de texto no seu servidor Discord chamado:

```
📜logs
```

### 4. Permissões do Bot

O bot precisa das seguintes permissões:
- `View Channels`
- `Send Messages`
- `Embed Links`
- `Read Message History`
- `View Audit Log`

---

## 🚀 Rodando Localmente

```bash
# Instalar dependências
npm install

# Compilar TypeScript
npm run build

# Iniciar o bot
npm start
```

---

## ☁️ Deploy na Discloud

O projeto já inclui o arquivo `discloud.config` pronto e a pasta `dist/` com o código compilado.

### Variável de segredo na Discloud:

| Chave | Valor |
|-------|-------|
| `DISCORD_TOKEN` | Seu token do bot |

### Via GitHub:
1. Faça push do código para o GitHub
2. Na Discloud, use a opção de deploy via repositório GitHub
3. Configure o segredo `DISCORD_TOKEN` no painel

---

## 📁 Estrutura

```
├── src/
│   └── index.ts          # Código principal do bot
├── dist/                 # Código compilado (incluso no repo)
│   └── index.js          # Arquivo principal compilado
├── discloud.config       # Configuração para Discloud
├── package.json
├── tsconfig.json
├── .env.example          # Template do .env
└── .gitignore
```

---

## 🛡️ Segurança

- O arquivo `.env` está no `.gitignore` — **nunca será enviado ao GitHub**
- **Nunca** compartilhe seu token de bot publicamente
- Se o token for exposto, **regenere imediatamente** no Developer Portal

---

## 📦 Tecnologias

- [TypeScript](https://www.typescriptlang.org/) v5
- [discord.js](https://discord.js.org/) v14
- [dotenv](https://www.npmjs.com/package/dotenv)
- Node.js 18+
