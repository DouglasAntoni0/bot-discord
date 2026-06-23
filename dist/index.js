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
// Set para rastrear mensagens que o bot está deletando automaticamente.
// Evita que a proteção de logs dispare quando o próprio bot faz limpeza.
// ─────────────────────────────────────────────────────────────────────────────
const autoDeletedMessageIds = new Set();
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
 * Busca entradas recentes no Audit Log com retry robusto.
 * Usa múltiplas tentativas com backoff progressivo para garantir
 * que o audit log tenha tempo de ser registrado pelo Discord.
 */
async function fetchAuditLog(guild, type, targetId, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Delay progressivo: 0ms, 800ms, 1600ms, 2400ms, 3200ms
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
            }
            const auditLogs = await guild.fetchAuditLogs({
                type,
                limit: 10,
            });
            const now = Date.now();
            // Primeira passagem: buscar entrada com targetId (se fornecido)
            if (targetId) {
                const exactMatch = auditLogs.entries.find((e) => {
                    const timeDiff = now - (e.createdTimestamp || 0);
                    if (timeDiff > 30000)
                        return false; // 30 segundos de janela
                    return e.targetId === targetId;
                });
                if (exactMatch)
                    return exactMatch;
            }
            // Segunda passagem: buscar qualquer entrada recente do mesmo tipo
            const recentMatch = auditLogs.entries.find((e) => {
                const timeDiff = now - (e.createdTimestamp || 0);
                return timeDiff <= 30000; // 30 segundos de janela
            });
            if (recentMatch)
                return recentMatch;
        }
        catch (error) {
            console.error(`[AUDIT LOG] Erro ao buscar audit log (tentativa ${attempt + 1}/${retries + 1}):`, error);
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
    console.log(`🧹 Limpeza automática: logs com mais de 7 dias`);
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
    // ── Iniciar limpeza automática de logs ──
    // Primeira limpeza após 30 segundos do boot
    setTimeout(() => cleanupOldLogs(readyClient), 30_000);
    // Limpeza recorrente a cada 6 horas
    setInterval(() => cleanupOldLogs(readyClient), 6 * 60 * 60 * 1000);
    console.log("  🧹 Limpeza automática agendada (a cada 6 horas)");
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
            // Verificar no audit log se foi desconectado por alguém (detecção robusta)
            let disconnectedBy = null;
            // Delay para dar tempo do audit log ser registrado
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                // Tentativa 1: buscar pelo targetId do membro
                let entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MemberDisconnect, member.user.id);
                // Tentativa 2: buscar sem targetId (fallback - MemberDisconnect nem sempre tem targetId)
                if (!entry) {
                    entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MemberDisconnect);
                }
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
            // Verificar no audit log quem moveu (detecção robusta)
            let movedBy = null;
            // Delay para dar tempo do audit log ser registrado
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                // Tentativa 1: buscar pelo targetId do membro
                let entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MemberMove, member.user.id);
                // Tentativa 2: buscar sem targetId (fallback)
                if (!entry) {
                    entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MemberMove);
                }
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
/**
 * Mensagens de zoeira quando alguém apaga uma log do bot.
 * O bot alterna aleatoriamente entre elas.
 */
const LOG_DELETE_RESPONSES = [
    // Opção 1 — Clássica e direta
    (name) => `🚨 **Epa, ${name}!** Pra que tá querendo apagar minhas logs? Tá aprontando né? Eu tô de olho em você. Vou salvar tudo, viu? Pare de aprontar, caba safado! 👀`,
    // Opção 3 — Modo detetive
    (name) => {
        const agora = new Date();
        const hora = agora.toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "America/Sao_Paulo",
        });
        return `🕵️ **Log de auditoria registrada.** O(A) senhor(a) **${name}** tentou apagar uma log minha às ${hora}. Acha que pode destruir provas? Eu SOU a prova. Tô de olho, safado(a)! 📋`;
    },
];
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
        // ─────────────────────────────────────────────────────────────────────
        // DETECÇÃO: Alguém apagou uma log do bot no canal de logs
        // ─────────────────────────────────────────────────────────────────────
        if (message.author?.id === client.user?.id &&
            message.channel.id === logChannel.id) {
            // Se foi auto-deletada pela limpeza automática, ignorar silenciosamente
            if (autoDeletedMessageIds.has(message.id)) {
                autoDeletedMessageIds.delete(message.id);
                console.log("[AUTO CLEANUP] Mensagem auto-deletada removida do cache - ignorando proteção.");
                return;
            }
            console.log("[LOG PROTECTION] Log do bot foi apagada! Investigando quem foi...");
            // Delay para o audit log ser registrado pelo Discord
            await new Promise((resolve) => setTimeout(resolve, 1500));
            let culprit = null;
            let culpritMention = null;
            try {
                // Buscar no audit log quem deletou a mensagem do bot
                let entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MessageDelete, client.user?.id);
                // Fallback: buscar qualquer deleção recente
                if (!entry) {
                    entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MessageDelete);
                }
                if (entry && entry.executor) {
                    // Ignorar se foi o próprio bot que deletou (ex: limpeza automática)
                    if (entry.executor.id === client.user?.id) {
                        console.log("[LOG PROTECTION] Bot deletou a própria log - ignorando.");
                        return;
                    }
                    culprit = entry.executor.displayName || entry.executor.username || entry.executor.tag;
                    culpritMention = `<@${entry.executor.id}>`;
                }
            }
            catch (err) {
                console.error("[LOG PROTECTION] Erro ao verificar audit log:", err);
            }
            // Montar a mensagem de zoeira
            const nome = culprit || "Algum espertinho";
            const randomIndex = Math.floor(Math.random() * LOG_DELETE_RESPONSES.length);
            const mensagemZoeira = LOG_DELETE_RESPONSES[randomIndex](nome);
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0xff0000)
                .setTitle("🚨 ALERTA: LOG APAGADA!")
                .setDescription(mensagemZoeira)
                .setTimestamp();
            if (culpritMention) {
                embed.setFooter({
                    text: `Infrator: ${culprit} • Esta ocorrência foi registrada.`,
                });
            }
            else {
                embed.setFooter({
                    text: "Não consegui identificar quem foi... mas estou de olho! 👁️",
                });
            }
            await logChannel.send({
                content: culpritMention ? `${culpritMention}` : undefined,
                embeds: [embed],
            });
            console.log(`[LOG PROTECTION] Mensagem de alerta enviada. Culpado: ${culprit || "Desconhecido"}`);
            return; // Não precisa logar essa deleção novamente como log normal
        }
        // ─────────────────────────────────────────────────────────────────────
        // LOG NORMAL: Mensagem de outro usuário deletada em outro canal
        // ─────────────────────────────────────────────────────────────────────
        // Ignorar mensagens do canal de logs (que não são do bot)
        if (message.channel.id === logChannel.id)
            return;
        // Ignorar bots
        if (message.author?.bot)
            return;
        const author = message.author;
        const content = message.content || "*[Sem conteúdo de texto]*";
        // ── Verificar quem deletou via Audit Log (detecção robusta) ──
        let deletedByTag = null;
        let selfDeleted = true;
        // Delay inicial para dar tempo do Discord registrar no audit log
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
            // Tentativa 1: buscar pelo targetId do autor
            let entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MessageDelete, author?.id);
            // Tentativa 2: se não encontrou, buscar sem targetId (fallback)
            if (!entry) {
                entry = await fetchAuditLog(guild, discord_js_1.AuditLogEvent.MessageDelete);
            }
            if (entry && entry.executor && author) {
                if (entry.executor.id !== author.id) {
                    deletedByTag = entry.executor.tag || `<@${entry.executor.id}>`;
                    selfDeleted = false;
                }
            }
        }
        catch (err) {
            console.error("[MSG DELETE] Erro ao verificar audit log:", err);
        }
        // ── Montar embed ──
        const authorMention = author ? `<@${author.id}>` : "*Desconhecido*";
        const channelMention = `<#${message.channel.id}>`;
        // Footer com quem deletou
        let footerText;
        if (selfDeleted) {
            footerText = "Apagada pelo próprio autor";
        }
        else {
            footerText = `Apagada por ${deletedByTag}`;
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(selfDeleted ? 0xe74c3c : 0xff4757)
            .setTitle("📋 Mensagem Apagada")
            .addFields({
            name: "Autor:",
            value: authorMention,
            inline: true,
        }, {
            name: "Canal:",
            value: channelMention,
            inline: true,
        }, {
            name: "📋 Conteúdo",
            value: truncateText(`\`\`\`\n${content}\n\`\`\``, 1024),
            inline: false,
        })
            .setFooter({ text: footerText })
            .setTimestamp();
        if (author) {
            embed.setAuthor({
                name: author.tag,
                iconURL: author.displayAvatarURL({ size: 64 }),
            });
        }
        // Adicionar info de anexos se houver
        if (message.attachments && message.attachments.size > 0) {
            const attachmentList = message.attachments
                .map((att) => att.name || "arquivo")
                .join(", ");
            embed.addFields({
                name: "📎 Anexos",
                value: truncateText(attachmentList, 1024),
                inline: false,
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
        const authorDisplay = author ? `${author.tag}` : "Desconhecido";
        // Data de criação da mensagem
        const createdAt = newMessage.createdAt;
        const createdUnix = createdAt ? Math.floor(createdAt.getTime() / 1000) : 0;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("✏️ Mensagem Editada")
            .addFields({
            name: "Autor:",
            value: `${authorMention} ( ${author?.id || "N/A"} )`,
            inline: true,
        }, {
            name: "Canal:",
            value: `<#${newMessage.channel.id}>`,
            inline: true,
        }, {
            name: "ID da Mensagem:",
            value: `${newMessage.id}`,
            inline: false,
        }, {
            name: "\u200b",
            value: `[Ir para a mensagem](${newMessage.url})`,
            inline: false,
        }, {
            name: "📝 Antes",
            value: truncateText(`\`\`\`\n${oldContent || "[Não disponível]"}\n\`\`\``, 1024),
            inline: false,
        }, {
            name: "✏️ Depois",
            value: truncateText(`\`\`\`\n${newContent || "[Sem conteúdo]"}\n\`\`\``, 1024),
            inline: false,
        }, {
            name: "📅 Mensagem criada em",
            value: createdUnix ? `<t:${createdUnix}:F> ( <t:${createdUnix}:R> )` : "*Desconhecido*",
            inline: false,
        })
            .setFooter({ text: `Editada por: ${authorDisplay}` })
            .setTimestamp();
        if (author) {
            embed.setAuthor({
                name: `${author.displayName} (${author.tag})`,
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
// Limpeza automática de logs com mais de 7 dias
// ─────────────────────────────────────────────────────────────────────────────
/** Tempo de retenção das logs: 7 dias em milissegundos */
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Limpa automaticamente mensagens do bot no canal de logs que têm mais de 7 dias.
 * Usa bulkDelete para mensagens com até 14 dias (limite do Discord)
 * e delete individual para mensagens mais antigas (caso raro).
 */
async function cleanupOldLogs(readyClient) {
    console.log("[AUTO CLEANUP] Iniciando limpeza de logs antigas...");
    for (const guild of readyClient.guilds.cache.values()) {
        try {
            const logChannel = getLogChannel(guild);
            if (!logChannel)
                continue;
            let totalDeleted = 0;
            let lastMessageId;
            let hasMore = true;
            while (hasMore) {
                // Buscar mensagens em lotes de 100 (limite da API)
                const fetchOptions = { limit: 100 };
                if (lastMessageId)
                    fetchOptions.before = lastMessageId;
                const messages = await logChannel.messages.fetch(fetchOptions);
                if (messages.size === 0) {
                    hasMore = false;
                    break;
                }
                // Atualizar o cursor para a próxima página
                const lastMsg = messages.last();
                if (lastMsg)
                    lastMessageId = lastMsg.id;
                // Se a mensagem mais recente do lote já é mais nova que 7 dias,
                // e a mais antiga também, pular para o próximo lote
                const now = Date.now();
                // Filtrar apenas mensagens do bot com mais de 7 dias
                const oldBotMessages = messages.filter((msg) => {
                    const age = now - msg.createdTimestamp;
                    return msg.author.id === readyClient.user.id && age > LOG_RETENTION_MS;
                });
                if (oldBotMessages.size === 0) {
                    // Se não encontrou mensagens antigas neste lote, verificar se
                    // a mensagem mais antiga do lote tem menos de 7 dias
                    // (significa que não há mais mensagens antigas pra frente)
                    if (lastMsg && now - lastMsg.createdTimestamp < LOG_RETENTION_MS) {
                        hasMore = false;
                    }
                    continue;
                }
                // Separar mensagens em: deletáveis via bulk (<14 dias) e individuais (>14 dias)
                const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
                const bulkDeletable = oldBotMessages.filter((msg) => now - msg.createdTimestamp < fourteenDaysMs);
                const tooOldForBulk = oldBotMessages.filter((msg) => now - msg.createdTimestamp >= fourteenDaysMs);
                // Registrar IDs no Set antes de deletar (para não disparar a proteção)
                for (const [id] of oldBotMessages) {
                    autoDeletedMessageIds.add(id);
                }
                // Deletar em lote (máx 100 por vez, mín 2 para bulkDelete)
                if (bulkDeletable.size >= 2) {
                    try {
                        await logChannel.bulkDelete(bulkDeletable);
                        totalDeleted += bulkDeletable.size;
                    }
                    catch (err) {
                        console.error(`[AUTO CLEANUP] Erro no bulkDelete:`, err);
                        // Fallback: deletar individualmente
                        for (const [, msg] of bulkDeletable) {
                            try {
                                await msg.delete();
                                totalDeleted++;
                                // Rate limit: esperar 1 segundo entre deleções individuais
                                await new Promise((r) => setTimeout(r, 1000));
                            }
                            catch (e) {
                                console.error(`[AUTO CLEANUP] Erro ao deletar msg ${msg.id}:`, e);
                            }
                        }
                    }
                }
                else if (bulkDeletable.size === 1) {
                    // bulkDelete não aceita menos de 2, deletar individualmente
                    const msg = bulkDeletable.first();
                    try {
                        await msg.delete();
                        totalDeleted++;
                    }
                    catch (e) {
                        console.error(`[AUTO CLEANUP] Erro ao deletar msg ${msg.id}:`, e);
                    }
                }
                // Deletar mensagens muito antigas individualmente
                for (const [, msg] of tooOldForBulk) {
                    try {
                        await msg.delete();
                        totalDeleted++;
                        // Rate limit: esperar 1 segundo entre deleções
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                    catch (e) {
                        console.error(`[AUTO CLEANUP] Erro ao deletar msg antiga ${msg.id}:`, e);
                    }
                }
                // Pequeno delay entre lotes para respeitar rate limits
                await new Promise((r) => setTimeout(r, 2000));
            }
            if (totalDeleted > 0) {
                console.log(`[AUTO CLEANUP] [${guild.name}] ${totalDeleted} log(s) antiga(s) removida(s).`);
            }
            else {
                console.log(`[AUTO CLEANUP] [${guild.name}] Nenhuma log antiga encontrada.`);
            }
            // Limpar IDs do Set após um tempo (segurança contra memory leak)
            setTimeout(() => {
                autoDeletedMessageIds.clear();
            }, 60_000);
        }
        catch (error) {
            console.error(`[AUTO CLEANUP] Erro no servidor ${guild.name}:`, error);
        }
    }
    console.log("[AUTO CLEANUP] Limpeza concluída.");
}
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