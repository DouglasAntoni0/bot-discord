"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const dotenv_1 = require("dotenv");
(0, dotenv_1.config)();
// ─────────────────────────────────────────────────────────────────────────────
// Configuração do cliente com TODAS as intents e partials necessárias
// ─────────────────────────────────────────────────────────────────────────────
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMembers,
        discord_js_1.GatewayIntentBits.GuildMessages,
        discord_js_1.GatewayIntentBits.GuildVoiceStates,
        discord_js_1.GatewayIntentBits.MessageContent,
        discord_js_1.GatewayIntentBits.GuildModeration,
    ],
    partials: [
        discord_js_1.Partials.Message, // Para capturar mensagens que não estão em cache
        discord_js_1.Partials.Channel, // Para capturar canais parciais
        discord_js_1.Partials.GuildMember, // Para capturar membros parciais
        discord_js_1.Partials.User, // Para capturar users parciais
    ],
});
// Nome do canal de logs
const LOG_CHANNEL_NAME = process.env.LOG_CHANNEL_NAME || "📜logs";
// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Busca o canal de logs em um servidor.
 * Procura por nome exato, incluindo com e sem emoji.
 */
function getLogChannel(guild) {
    const channel = guild.channels.cache.find((ch) => ch.type === discord_js_1.ChannelType.GuildText &&
        (ch.name === LOG_CHANNEL_NAME ||
            ch.name === "📜logs" ||
            ch.name === "logs" ||
            ch.name === "📜-logs" ||
            ch.name === "📜│logs"));
    if (channel && channel.type === discord_js_1.ChannelType.GuildText) {
        return channel;
    }
    return null;
}
/**
 * Formata timestamp para o Discord (formato relativo e absoluto)
 */
function formatTimestamp(date = new Date()) {
    const unix = Math.floor(date.getTime() / 1000);
    return `<t:${unix}:F> (<t:${unix}:R>)`;
}
/**
 * Trunca texto para caber no embed (máximo 1024 chars por field)
 */
function truncateText(text, maxLength = 1024) {
    if (text.length <= maxLength)
        return text;
    return text.substring(0, maxLength - 3) + "...";
}
/**
 * Busca entradas recentes no Audit Log com retry
 */
async function fetchAuditLog(guild, type, targetId, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Pequeno delay para dar tempo do audit log ser registrado
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            }
            const auditLogs = await guild.fetchAuditLogs({
                type,
                limit: 5,
            });
            const now = Date.now();
            const entry = auditLogs.entries.find((e) => {
                // A entrada deve ser recente (últimos 10 segundos)
                const timeDiff = now - (e.createdTimestamp || 0);
                if (timeDiff > 10000)
                    return false;
                // Se temos targetId, verificar se bate
                if (targetId && e.targetId !== targetId)
                    return false;
                return true;
            });
            if (entry)
                return entry;
        }
        catch (error) {
            console.error(`[AUDIT LOG] Erro ao buscar audit log (tentativa ${attempt + 1}):`, error);
        }
    }
    return null;
}
// ─────────────────────────────────────────────────────────────────────────────
// Evento: Bot pronto
// ─────────────────────────────────────────────────────────────────────────────
client.once(discord_js_1.Events.ClientReady, (readyClient) => {
    console.log("═══════════════════════════════════════════════════════");
    console.log(`✅ Bot conectado como: ${readyClient.user.tag}`);
    console.log(`📊 Servidores: ${readyClient.guilds.cache.size}`);
    console.log(`📋 Canal de logs: ${LOG_CHANNEL_NAME}`);
    console.log("═══════════════════════════════════════════════════════");
    // Verificar canais de log em todos os servidores
    readyClient.guilds.cache.forEach((guild) => {
        const logChannel = getLogChannel(guild);
        if (logChannel) {
            console.log(`  ✅ [${guild.name}] Canal de logs encontrado: #${logChannel.name}`);
        }
        else {
            console.warn(`  ⚠️ [${guild.name}] Canal de logs "${LOG_CHANNEL_NAME}" NÃO encontrado!`);
        }
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// Evento: Voice State Update (entrar, sair, mover de call)
// ─────────────────────────────────────────────────────────────────────────────
client.on(discord_js_1.Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
        const guild = newState.guild || oldState.guild;
        if (!guild)
            return;
        const logChannel = getLogChannel(guild);
        if (!logChannel)
            return;
        const member = newState.member || oldState.member;
        if (!member)
            return;
        // Ignorar bots
        if (member.user.bot)
            return;
        const memberTag = `${member.user.tag}`;
        const memberMention = `<@${member.user.id}>`;
        const memberAvatar = member.user.displayAvatarURL({ size: 64 });
        // ── ENTROU EM UMA CALL ──
        if (!oldState.channelId && newState.channelId) {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x2ecc71)
                .setAuthor({ name: memberTag, iconURL: memberAvatar })
                .setTitle("🎙️ Entrada em Canal de Voz")
                .setDescription(`${memberMention} entrou no canal de voz <#${newState.channelId}>.`)
                .setTimestamp();
            await logChannel.send({ embeds: [embed] });
            return;
        }
        // ── SAIU DE UMA CALL ──
        if (oldState.channelId && !newState.channelId) {
            // Verificar no audit log se foi desconectado por alguém
            let disconnectedBy = null;
            try {
                const entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MemberDisconnect, undefined);
                if (entry && entry.executor && entry.executor.id !== member.user.id) {
                    disconnectedBy = `<@${entry.executor.id}>`;
                }
            }
            catch (err) {
                console.error("[VOICE] Erro ao verificar audit log de disconnect:", err);
            }
            const embed = new discord_js_1.EmbedBuilder()
                .setAuthor({ name: memberTag, iconURL: memberAvatar })
                .setTimestamp();
            if (disconnectedBy) {
                embed
                    .setColor(0xff6b6b)
                    .setTitle("🔇 Desconectado de Canal de Voz")
                    .setDescription(`${memberMention} foi desconectado do canal de voz <#${oldState.channelId}> por ${disconnectedBy}.`);
            }
            else {
                embed
                    .setColor(0xe74c3c)
                    .setTitle("🔇 Saída de Canal de Voz")
                    .setDescription(`${memberMention} saiu do canal de voz <#${oldState.channelId}>.`);
            }
            await logChannel.send({ embeds: [embed] });
            return;
        }
        // ── MOVIDO DE CALL ──
        if (oldState.channelId &&
            newState.channelId &&
            oldState.channelId !== newState.channelId) {
            // Verificar no audit log quem moveu
            let movedBy = null;
            try {
                const entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MemberMove, undefined);
                if (entry && entry.executor && entry.executor.id !== member.user.id) {
                    movedBy = `<@${entry.executor.id}>`;
                }
            }
            catch (err) {
                console.error("[VOICE] Erro ao verificar audit log de move:", err);
            }
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0xf39c12)
                .setAuthor({ name: memberTag, iconURL: memberAvatar })
                .setTimestamp();
            if (movedBy) {
                embed
                    .setTitle("🔀 Movido entre Canais de Voz")
                    .setDescription(`${memberMention} foi movido de <#${oldState.channelId}> para <#${newState.channelId}> por ${movedBy}.`);
            }
            else {
                embed
                    .setTitle("🔀 Movido entre Canais de Voz")
                    .setDescription(`${memberMention} se moveu de <#${oldState.channelId}> para <#${newState.channelId}>.`);
            }
            await logChannel.send({ embeds: [embed] });
            return;
        }
    }
    catch (error) {
        console.error("[VOICE STATE UPDATE] Erro geral:", error);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Evento: Mensagem Deletada
// ─────────────────────────────────────────────────────────────────────────────
client.on(discord_js_1.Events.MessageDelete, async (message) => {
    try {
        // Tentar fazer fetch do partial
        if (message.partial) {
            try {
                console.log("[MSG DELETE] Mensagem parcial detectada - usando dados do cache");
            }
            catch {
                console.log("[MSG DELETE] Não foi possível recuperar mensagem parcial");
                return;
            }
        }
        const guild = message.guild;
        if (!guild)
            return;
        const logChannel = getLogChannel(guild);
        if (!logChannel)
            return;
        // Ignorar mensagens do próprio bot e do canal de logs
        if (message.author?.id === client.user?.id)
            return;
        if (message.channel.id === logChannel.id)
            return;
        // Ignorar bots
        if (message.author?.bot)
            return;
        const author = message.author;
        const content = message.content || "*[Sem conteúdo de texto]*";
        // Verificar quem deletou via Audit Log
        let deletedBy = null;
        // Pequeno delay para o audit log ser registrado
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
            const entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MessageDelete, author?.id);
            if (entry && entry.executor && author) {
                if (entry.executor.id !== author.id) {
                    deletedBy = `<@${entry.executor.id}>`;
                }
            }
        }
        catch (err) {
            console.error("[MSG DELETE] Erro ao verificar audit log:", err);
        }
        const authorMention = author ? `<@${author.id}>` : "*Desconhecido*";
        let description = `Mensagem de ${authorMention} em <#${message.channel.id}> foi deletada.`;
        if (deletedBy) {
            description += `\nDeletada por ${deletedBy}.`;
        }
        description += `\n\n**Conteúdo:**\n${truncateText(content, 900)}`;
        // Adicionar info de anexos se houver
        if (message.attachments && message.attachments.size > 0) {
            description += `\n📎 ${message.attachments.size} anexo(s)`;
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(deletedBy ? 0xff4757 : 0xe74c3c)
            .setTitle("🗑️ Mensagem Deletada")
            .setDescription(truncateText(description, 4096))
            .setTimestamp();
        if (author) {
            embed.setAuthor({
                name: author.tag,
                iconURL: author.displayAvatarURL({ size: 64 }),
            });
        }
        await logChannel.send({ embeds: [embed] });
    }
    catch (error) {
        console.error("[MESSAGE DELETE] Erro geral:", error);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Evento: Mensagens Deletadas em Bulk
// ─────────────────────────────────────────────────────────────────────────────
client.on(discord_js_1.Events.MessageBulkDelete, async (messages, channel) => {
    try {
        const firstMsg = messages.first();
        const guild = firstMsg?.guild;
        if (!guild)
            return;
        const logChannel = getLogChannel(guild);
        if (!logChannel)
            return;
        if (channel.id === logChannel.id)
            return;
        // Verificar quem deletou em massa
        let deletedBy = "*Desconhecido*";
        try {
            const entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MessageBulkDelete);
            if (entry && entry.executor) {
                deletedBy = `<@${entry.executor.id}>`;
            }
        }
        catch (err) {
            console.error("[BULK DELETE] Erro ao verificar audit log:", err);
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x8b0000)
            .setTitle("🗑️ Mensagens Deletadas em Massa")
            .setDescription(`**${messages.size}** mensagens deletadas em <#${channel.id}> por ${deletedBy}.`)
            .setTimestamp();
        await logChannel.send({ embeds: [embed] });
    }
    catch (error) {
        console.error("[BULK DELETE] Erro geral:", error);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Evento: Mensagem Editada
// ─────────────────────────────────────────────────────────────────────────────
client.on(discord_js_1.Events.MessageUpdate, async (oldMessage, newMessage) => {
    try {
        // Tentar resolver partials
        if (oldMessage.partial) {
            try {
                await oldMessage.fetch();
            }
            catch {
                console.log("[MSG EDIT] Não foi possível buscar mensagem antiga parcial");
            }
        }
        if (newMessage.partial) {
            try {
                await newMessage.fetch();
            }
            catch {
                console.log("[MSG EDIT] Não foi possível buscar mensagem nova parcial");
                return;
            }
        }
        const guild = newMessage.guild;
        if (!guild)
            return;
        const logChannel = getLogChannel(guild);
        if (!logChannel)
            return;
        // Ignorar bots
        if (newMessage.author?.bot)
            return;
        // Ignorar o próprio bot
        if (newMessage.author?.id === client.user?.id)
            return;
        // Ignorar canal de logs
        if (newMessage.channel.id === logChannel.id)
            return;
        // Ignorar se o conteúdo não mudou (pode ser update de embed/attachment)
        const oldContent = oldMessage.content || "";
        const newContent = newMessage.content || "";
        if (oldContent === newContent)
            return;
        const author = newMessage.author;
        const authorMention = author ? `<@${author.id}>` : "*Desconhecido*";
        let description = `${authorMention} editou uma mensagem em <#${newMessage.channel.id}>. [Ver mensagem](${newMessage.url})`;
        description += `\n\n**Antes:** ${truncateText(oldContent || "*[Não disponível]*", 900)}`;
        description += `\n**Depois:** ${truncateText(newContent || "*[Sem conteúdo]*", 900)}`;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("✏️ Mensagem Editada")
            .setDescription(truncateText(description, 4096))
            .setTimestamp();
        if (author) {
            embed.setAuthor({
                name: author.tag,
                iconURL: author.displayAvatarURL({ size: 64 }),
            });
        }
        await logChannel.send({ embeds: [embed] });
    }
    catch (error) {
        console.error("[MESSAGE UPDATE] Erro geral:", error);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tratamento de erros globais
// ─────────────────────────────────────────────────────────────────────────────
client.on(discord_js_1.Events.Error, (error) => {
    console.error("[DISCORD.JS ERROR]", error);
});
client.on(discord_js_1.Events.Warn, (warning) => {
    console.warn("[DISCORD.JS WARN]", warning);
});
process.on("unhandledRejection", (error) => {
    console.error("[UNHANDLED REJECTION]", error);
});
process.on("uncaughtException", (error) => {
    console.error("[UNCAUGHT EXCEPTION]", error);
});
// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error("❌ DISCORD_TOKEN não encontrado no .env!");
    console.error('   Crie um arquivo .env com: DISCORD_TOKEN=seu_token_aqui');
    process.exit(1);
}
client.login(token).catch((error) => {
    console.error("❌ Falha ao fazer login:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map