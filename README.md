# 🤖 Bot Discord — Sistema de Logs

Bot de Discord feito em **TypeScript** com **discord.js v14** para registrar eventos do servidor em um canal de logs.

---

## 📋 Funcionalidades

### 🎙️ Logs de Voice Chat
- Registra quem **entrou** em um canal de voz e em qual canal
- Registra quem **saiu** de um canal de voz
- Detecta se alguém foi **desconectado** por outra pessoa
- Registra quando alguém é **movido** de canal, mostrando de onde → para onde
- Identifica se a pessoa **mudou sozinha** ou se foi **movida por outra pessoa**

### 🗑️ Logs de Mensagens Deletadas
- Registra o **conteúdo** da mensagem deletada
- Mostra em qual **canal** a mensagem estava
- Identifica se foi a **própria pessoa** que deletou ou se foi um **moderador**
- Registra **anexos** e **stickers** que estavam na mensagem
- Suporta **deleção em massa** (bulk delete)

### ✏️ Logs de Mensagens Editadas
- Mostra o conteúdo **antes** da edição
- Mostra o conteúdo **depois** da edição
- Identifica **quem** editou
- Link direto para a mensagem editada

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

O projeto já inclui o arquivo `discloud.config` pronto.

### Variável de segredo na Discloud:

| Chave | Valor |
|-------|-------|
| `DISCORD_TOKEN` | Seu token do bot |

### Para fazer upload:
1. Compacte os arquivos em `.zip` (**sem** `node_modules/` e `dist/`)
2. Faça upload na Discloud
3. Configure o segredo `DISCORD_TOKEN` no painel

---

## 📁 Estrutura

```
├── src/
│   └── index.ts          # Código principal do bot
├── dist/                 # Código compilado (gerado pelo build)
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
