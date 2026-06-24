"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const dotenv_1 = require("dotenv");
(0, dotenv_1.config)();
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
        discord_js_1.Partials.Message,
        discord_js_1.Partials.Channel,
        discord_js_1.Partials.GuildMember,
        discord_js_1.Partials.User,
    ],
    makeCache: discord_js_1.Options.cacheWithLimits({
        ...discord_js_1.Options.DefaultMakeCacheSettings,
        MessageManager: 500,
    }),
});
const DEFAULT_LOG_CHANNEL_NAME = "📜logs";
const FALLBACK_LOG_CHANNEL_NAMES = [
    DEFAULT_LOG_CHANNEL_NAME,
    "logs",
    "📜-logs",
    "📜│logs",
];
const LOG_CHANNEL_NAME = readTextEnv("LOG_CHANNEL_NAME", DEFAULT_LOG_CHANNEL_NAME);
const LOG_CHANNEL_ID = readSnowflakeEnv("LOG_CHANNEL_ID");
const LOG_RETENTION_DAYS = readIntegerEnv("LOG_RETENTION_DAYS", 5, 1, 90);
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const AUDIT_LOG_MAX_AGE_MS = 30_000;
const TRACKED_DELETE_TTL_MS = 10 * 60 * 1000;
const logChannelCache = new Map();
let cleanupRunning = false;
class ExpiringIdSet {
    defaultTtlMs;
    timeouts = new Map();
    constructor(defaultTtlMs) {
        this.defaultTtlMs = defaultTtlMs;
    }
    add(id, ttlMs = this.defaultTtlMs) {
        this.delete(id);
        const timeout = setTimeout(() => {
            this.timeouts.delete(id);
        }, ttlMs);
        timeout.unref?.();
        this.timeouts.set(id, timeout);
    }
    consume(id) {
        const timeout = this.timeouts.get(id);
        if (!timeout)
            return false;
        clearTimeout(timeout);
        this.timeouts.delete(id);
        return true;
    }
    delete(id) {
        const timeout = this.timeouts.get(id);
        if (!timeout)
            return;
        clearTimeout(timeout);
        this.timeouts.delete(id);
    }
}
const autoDeletedMessageIds = new ExpiringIdSet(TRACKED_DELETE_TTL_MS);
const alertMessageIds = new ExpiringIdSet(TRACKED_DELETE_TTL_MS);
function readTextEnv(name, defaultValue) {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : defaultValue;
}
function readSnowflakeEnv(name) {
    const value = process.env[name]?.trim();
    if (!value)
        return undefined;
    const match = value.match(/\d{17,20}/);
    if (!match) {
        console.warn(`[CONFIG] ${name} inválido. Usando fallback por nome de canal.`);
        return undefined;
    }
    return match[0];
}
function readIntegerEnv(name, defaultValue, min, max) {
    const raw = process.env[name]?.trim();
    if (!raw)
        return defaultValue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        console.warn(`[CONFIG] ${name} inválido (${raw}). Usando ${defaultValue}.`);
        return defaultValue;
    }
    if (parsed < min || parsed > max) {
        const clamped = Math.min(Math.max(parsed, min), max);
        console.warn(`[CONFIG] ${name} fora do intervalo ${min}-${max}. Usando ${clamped}.`);
        return clamped;
    }
    return parsed;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function truncateText(text, maxLength = 1024) {
    if (text.length <= maxLength)
        return text;
    if (maxLength <= 3)
        return text.slice(0, maxLength);
    return `${text.slice(0, maxLength - 3)}...`;
}
function escapeCodeBlock(text) {
    return text.replace(/```/g, "`\u200b``");
}
function formatCodeBlock(text, emptyText = "[Sem conteúdo de texto]", maxLength = 1024) {
    const prefix = "```\n";
    const suffix = "\n```";
    const value = text.length > 0 ? text : emptyText;
    const maxBodyLength = Math.max(0, maxLength - prefix.length - suffix.length);
    return `${prefix}${truncateText(escapeCodeBlock(value), maxBodyLength)}${suffix}`;
}
function formatTimestamp(date = new Date()) {
    const unix = Math.floor(date.getTime() / 1000);
    return `<t:${unix}:F> (<t:${unix}:R>)`;
}
function confidenceLabel(confidence) {
    switch (confidence) {
        case "confirmed":
            return "confirmado";
        case "probable":
            return "provável";
        default:
            return "não identificado";
    }
}
function formatUserId(id) {
    return `<@${id}> (${id})`;
}
function getExecutor(resolution) {
    return resolution.entry?.executor ?? null;
}
function getExecutorMention(resolution) {
    const executor = getExecutor(resolution);
    return executor ? `<@${executor.id}>` : null;
}
function getExecutorDisplay(resolution) {
    const executor = getExecutor(resolution);
    if (!executor)
        return null;
    return executor.tag || executor.username || executor.id;
}
function getAuditEntryChannelId(entry) {
    const extra = entry.extra;
    return extra?.channel?.id ?? extra?.channelId ?? null;
}
function entryDoesNotConflictWithChannel(entry, channelId) {
    if (!channelId)
        return true;
    const entryChannelId = getAuditEntryChannelId(entry);
    if (entryChannelId)
        return entryChannelId === channelId;
    if (entry.targetId === channelId)
        return true;
    return true;
}
function entryHasKnownChannelMatch(entry, channelId) {
    if (!channelId)
        return true;
    const entryChannelId = getAuditEntryChannelId(entry);
    if (entryChannelId)
        return entryChannelId === channelId;
    return entry.targetId === channelId;
}
function chooseEntryWithSingleExecutor(entries) {
    const executorIds = new Set(entries.map((entry) => entry.executor?.id).filter((id) => Boolean(id)));
    if (executorIds.size !== 1)
        return null;
    const executorId = [...executorIds][0];
    return (entries
        .filter((entry) => entry.executor?.id === executorId)
        .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))[0] ?? null);
}
async function resolveAuditLog(guild, options) {
    const maxAgeMs = options.maxAgeMs ?? AUDIT_LOG_MAX_AGE_MS;
    const retries = options.retries ?? 3;
    const initialDelayMs = options.initialDelayMs ?? 700;
    const retryDelayMs = options.retryDelayMs ?? 700;
    let lastCandidates = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt === 0 && initialDelayMs > 0) {
            await delay(initialDelayMs);
        }
        else if (attempt > 0) {
            await delay(retryDelayMs * attempt);
        }
        try {
            const auditLogs = await guild.fetchAuditLogs({
                type: options.type,
                limit: 10,
            });
            const now = Date.now();
            const recentEntries = auditLogs.entries
                .filter((entry) => {
                const createdTimestamp = entry.createdTimestamp ?? 0;
                const age = now - createdTimestamp;
                return age >= 0 && age <= maxAgeMs;
            })
                .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0));
            lastCandidates = recentEntries.size;
            const recent = [...recentEntries.values()];
            if (options.targetId) {
                const targetCandidates = recent.filter((entry) => entry.targetId === options.targetId &&
                    entryDoesNotConflictWithChannel(entry, options.channelId));
                const selected = chooseEntryWithSingleExecutor(targetCandidates);
                if (selected) {
                    return {
                        confidence: "confirmed",
                        entry: selected,
                        candidates: targetCandidates.length,
                        reason: "Audit log bateu com tipo, alvo, janela de tempo e executor único.",
                    };
                }
                if (targetCandidates.length > 1) {
                    return {
                        confidence: "unknown",
                        entry: null,
                        candidates: targetCandidates.length,
                        reason: "Mais de um executor possível para o mesmo alvo na janela analisada.",
                    };
                }
            }
            if (options.allowProbable) {
                const knownChannelMatches = recent.filter((entry) => entryHasKnownChannelMatch(entry, options.channelId));
                const hasKnownChannelData = recent.some((entry) => getAuditEntryChannelId(entry) || entry.targetId === options.channelId);
                const probableCandidates = options.channelId && hasKnownChannelData ? knownChannelMatches : recent;
                const selected = chooseEntryWithSingleExecutor(probableCandidates);
                if (selected) {
                    return {
                        confidence: "probable",
                        entry: selected,
                        candidates: probableCandidates.length,
                        reason: "Audit log recente do mesmo tipo com executor único, mas sem alvo exato exposto pelo Discord.",
                    };
                }
            }
        }
        catch (error) {
            console.error(`[AUDIT LOG] Erro ao buscar audit log (tentativa ${attempt + 1}/${retries + 1}):`, error);
        }
    }
    return {
        confidence: "unknown",
        entry: null,
        candidates: lastCandidates,
        reason: "Nenhuma entrada confiável foi encontrada na janela analisada.",
    };
}
async function resolveTextChannelById(guild, channelId) {
    const cached = guild.channels.cache.get(channelId);
    if (cached?.type === discord_js_1.ChannelType.GuildText)
        return cached;
    try {
        const fetched = await guild.channels.fetch(channelId);
        if (fetched?.type === discord_js_1.ChannelType.GuildText)
            return fetched;
    }
    catch (error) {
        console.warn(`[LOG CHANNEL] Não consegui buscar o canal ${channelId} em ${guild.name}:`, error);
    }
    return null;
}
async function getLogChannel(guild) {
    const cachedId = logChannelCache.get(guild.id);
    if (cachedId) {
        const cachedChannel = await resolveTextChannelById(guild, cachedId);
        if (cachedChannel)
            return cachedChannel;
        logChannelCache.delete(guild.id);
    }
    if (LOG_CHANNEL_ID) {
        const channelById = await resolveTextChannelById(guild, LOG_CHANNEL_ID);
        if (channelById) {
            logChannelCache.set(guild.id, channelById.id);
            return channelById;
        }
    }
    const acceptedNames = new Set([LOG_CHANNEL_NAME, ...FALLBACK_LOG_CHANNEL_NAMES]);
    const channelByName = guild.channels.cache.find((channel) => channel.type === discord_js_1.ChannelType.GuildText && acceptedNames.has(channel.name));
    if (channelByName?.type === discord_js_1.ChannelType.GuildText) {
        logChannelCache.set(guild.id, channelByName.id);
        return channelByName;
    }
    return null;
}
async function sendLog(logChannel, payload, context) {
    try {
        return await logChannel.send(payload);
    }
    catch (error) {
        console.error(`[SEND LOG] Falha ao enviar log (${context}):`, error);
        return null;
    }
}
async function validateLogChannel(guild) {
    const logChannel = await getLogChannel(guild);
    if (!logChannel) {
        const configured = LOG_CHANNEL_ID
            ? `ID ${LOG_CHANNEL_ID}`
            : `nome "${LOG_CHANNEL_NAME}"`;
        console.warn(`[READY] [${guild.name}] Canal de logs não encontrado (${configured}).`);
        return;
    }
    let me = guild.members.me;
    if (!me) {
        try {
            me = await guild.members.fetchMe();
        }
        catch (error) {
            console.warn(`[READY] [${guild.name}] Não consegui buscar o membro do bot:`, error);
            return;
        }
    }
    const channelPermissions = logChannel.permissionsFor(me);
    const requiredChannelPermissions = [
        { flag: discord_js_1.PermissionFlagsBits.ViewChannel, name: "View Channels" },
        { flag: discord_js_1.PermissionFlagsBits.SendMessages, name: "Send Messages" },
        { flag: discord_js_1.PermissionFlagsBits.EmbedLinks, name: "Embed Links" },
        { flag: discord_js_1.PermissionFlagsBits.ReadMessageHistory, name: "Read Message History" },
    ];
    const missingChannelPermissions = requiredChannelPermissions
        .filter((permission) => !channelPermissions?.has(permission.flag))
        .map((permission) => permission.name);
    console.log(`  ✅ [${guild.name}] Canal de logs: #${logChannel.name} (${logChannel.id})`);
    if (missingChannelPermissions.length > 0) {
        console.warn(`  ⚠️ [${guild.name}] Permissões ausentes no canal de logs: ${missingChannelPermissions.join(", ")}`);
    }
    if (!me.permissions.has(discord_js_1.PermissionFlagsBits.ViewAuditLog)) {
        console.warn(`  ⚠️ [${guild.name}] Sem permissão View Audit Log. O bot continuará logando, mas identificará menos responsáveis.`);
    }
    if (!channelPermissions?.has(discord_js_1.PermissionFlagsBits.ManageMessages)) {
        console.warn(`  ⚠️ [${guild.name}] Sem Manage Messages em #${logChannel.name}. A limpeza automática pode falhar.`);
    }
}
function buildVoiceActorText(resolution) {
    const mention = getExecutorMention(resolution);
    if (!mention)
        return null;
    return `${mention} (${confidenceLabel(resolution.confidence)} pelo Audit Log)`;
}
client.once(discord_js_1.Events.ClientReady, async (readyClient) => {
    console.log("═══════════════════════════════════════════════════════");
    console.log(`✅ Bot conectado como: ${readyClient.user.tag}`);
    console.log(`📊 Servidores: ${readyClient.guilds.cache.size}`);
    console.log(`📋 Canal de logs por ID: ${LOG_CHANNEL_ID ?? "não configurado"}`);
    console.log(`📋 Canal de logs por nome: ${LOG_CHANNEL_NAME}`);
    console.log(`🧹 Retenção automática: logs com mais de ${LOG_RETENTION_DAYS} dia(s)`);
    console.log("═══════════════════════════════════════════════════════");
    for (const guild of readyClient.guilds.cache.values()) {
        await validateLogChannel(guild);
    }
    setTimeout(() => {
        void cleanupOldLogs(readyClient);
    }, 30_000);
    setInterval(() => {
        void cleanupOldLogs(readyClient);
    }, 6 * 60 * 60 * 1000);
    console.log("  🧹 Limpeza automática agendada (a cada 6 horas)");
});
client.on(discord_js_1.Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
        const guild = newState.guild || oldState.guild;
        const logChannel = await getLogChannel(guild);
        if (!logChannel)
            return;
        const member = newState.member || oldState.member;
        if (!member || member.user.bot)
            return;
        const memberTag = member.user.tag;
        const memberMention = `<@${member.user.id}>`;
        const memberAvatar = member.user.displayAvatarURL({ size: 64 });
        if (!oldState.channelId && newState.channelId) {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x2ecc71)
                .setAuthor({ name: memberTag, iconURL: memberAvatar })
                .setTitle("🎙️ Entrada em Canal de Voz")
                .setDescription(`${memberMention} entrou no canal de voz <#${newState.channelId}>.`)
                .addFields({ name: "Usuário", value: formatUserId(member.user.id), inline: false })
                .setTimestamp();
            await sendLog(logChannel, { embeds: [embed] }, "voice join");
            return;
        }
        if (oldState.channelId && !newState.channelId) {
            const resolution = await resolveAuditLog(guild, {
                type: discord_js_1.AuditLogEvent.MemberDisconnect,
                channelId: oldState.channelId,
                allowProbable: true,
            });
            const actorText = buildVoiceActorText(resolution);
            const embed = new discord_js_1.EmbedBuilder()
                .setAuthor({ name: memberTag, iconURL: memberAvatar })
                .addFields({ name: "Usuário", value: formatUserId(member.user.id), inline: false }, { name: "Canal", value: `<#${oldState.channelId}> (${oldState.channelId})`, inline: false })
                .setFooter({ text: resolution.reason })
                .setTimestamp();
            if (actorText && getExecutor(resolution)?.id !== member.user.id) {
                embed
                    .setColor(0xff6b6b)
                    .setTitle("🔇 Desconectado de Canal de Voz")
                    .setDescription(`${memberMention} foi desconectado do canal de voz <#${oldState.channelId}> por ${actorText}.`);
            }
            else {
                embed
                    .setColor(0xe74c3c)
                    .setTitle("🔇 Saída de Canal de Voz")
                    .setDescription(`${memberMention} saiu do canal de voz <#${oldState.channelId}>. Não houve responsável confirmado no Audit Log.`);
            }
            await sendLog(logChannel, { embeds: [embed] }, "voice leave");
            return;
        }
        if (oldState.channelId &&
            newState.channelId &&
            oldState.channelId !== newState.channelId) {
            const resolution = await resolveAuditLog(guild, {
                type: discord_js_1.AuditLogEvent.MemberMove,
                channelId: newState.channelId,
                allowProbable: true,
            });
            const actorText = buildVoiceActorText(resolution);
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0xf39c12)
                .setAuthor({ name: memberTag, iconURL: memberAvatar })
                .addFields({ name: "Usuário", value: formatUserId(member.user.id), inline: false }, { name: "Origem", value: `<#${oldState.channelId}> (${oldState.channelId})`, inline: true }, { name: "Destino", value: `<#${newState.channelId}> (${newState.channelId})`, inline: true })
                .setFooter({ text: resolution.reason })
                .setTimestamp();
            if (actorText && getExecutor(resolution)?.id !== member.user.id) {
                embed
                    .setTitle("🔀 Movido entre Canais de Voz")
                    .setDescription(`${memberMention} foi movido de <#${oldState.channelId}> para <#${newState.channelId}> por ${actorText}.`);
            }
            else {
                embed
                    .setTitle("🔀 Movido entre Canais de Voz")
                    .setDescription(`${memberMention} se moveu de <#${oldState.channelId}> para <#${newState.channelId}>. Não houve responsável confirmado no Audit Log.`);
            }
            await sendLog(logChannel, { embeds: [embed] }, "voice move");
        }
    }
    catch (error) {
        console.error("[VOICE STATE UPDATE] Erro geral:", error);
    }
});
const LOG_DELETE_RESPONSES = {
    confirmed: (name) => `🚨 **Epa, ${name}!** Vi no Audit Log que você apagou uma log minha. Vou registrar esta ocorrência e manter tudo mais rastreável daqui pra frente.`,
    probable: (name) => `🚨 **Atenção.** Uma log minha foi apagada e o Audit Log aponta **${name}** como provável responsável. Não vou cravar além do que o Discord mostrou, mas deixei registrado.`,
    unknown: () => "🚨 **Uma log minha foi apagada.** Não consegui confirmar quem foi pelo Audit Log, então não vou acusar ninguém. A ocorrência ficou registrada mesmo assim.",
};
function buildMessageDeleteFooter(resolution, authorId) {
    const executor = getExecutor(resolution);
    if (executor && resolution.confidence !== "unknown") {
        if (authorId && executor.id === authorId) {
            return `Responsável: próprio autor (${confidenceLabel(resolution.confidence)})`;
        }
        return `Responsável: ${executor.tag || executor.username} (${confidenceLabel(resolution.confidence)})`;
    }
    return "Sem registro de moderação confiável. Provavelmente apagada pelo próprio autor ou não disponível no Audit Log.";
}
function buildAttachmentList(message) {
    if (!message.attachments || message.attachments.size === 0)
        return null;
    const attachments = message.attachments.map((attachment) => {
        const name = attachment.name || "arquivo";
        return attachment.url ? `[${truncateText(name, 80)}](${attachment.url})` : name;
    });
    return truncateText(attachments.join("\n"), 1024);
}
client.on(discord_js_1.Events.MessageDelete, async (message) => {
    try {
        const wasPartial = message.partial;
        if (wasPartial) {
            console.log("[MSG DELETE] Mensagem parcial detectada. Conteúdo/autor podem estar indisponíveis porque a mensagem não estava em cache.");
        }
        const guild = message.guild;
        if (!guild)
            return;
        const logChannel = await getLogChannel(guild);
        if (!logChannel)
            return;
        if (message.author?.id === client.user?.id &&
            message.channel.id === logChannel.id) {
            if (autoDeletedMessageIds.consume(message.id)) {
                console.log("[AUTO CLEANUP] Mensagem apagada pela limpeza automática. Ignorando proteção.");
                return;
            }
            if (alertMessageIds.consume(message.id)) {
                console.log("[LOG PROTECTION] Mensagem de alerta apagada. Ignorando para evitar loop.");
                return;
            }
            console.log("[LOG PROTECTION] Log do bot apagada. Investigando responsável...");
            const resolution = await resolveAuditLog(guild, {
                type: discord_js_1.AuditLogEvent.MessageDelete,
                targetId: client.user?.id,
                channelId: logChannel.id,
                allowProbable: true,
            });
            const executor = getExecutor(resolution);
            if (executor?.id === client.user?.id) {
                console.log("[LOG PROTECTION] O próprio bot apagou a log. Ignorando.");
                return;
            }
            const culpritName = getExecutorDisplay(resolution);
            const culpritMention = getExecutorMention(resolution);
            const response = resolution.confidence === "confirmed" && culpritName
                ? LOG_DELETE_RESPONSES.confirmed(culpritName)
                : resolution.confidence === "probable" && culpritName
                    ? LOG_DELETE_RESPONSES.probable(culpritName)
                    : LOG_DELETE_RESPONSES.unknown();
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(resolution.confidence === "unknown" ? 0xffa502 : 0xff0000)
                .setTitle("🚨 ALERTA: LOG APAGADA")
                .setDescription(response)
                .addFields({ name: "Canal", value: `<#${logChannel.id}> (${logChannel.id})`, inline: false }, { name: "ID da mensagem apagada", value: message.id, inline: false }, { name: "Confiança", value: confidenceLabel(resolution.confidence), inline: true }, { name: "Critério", value: truncateText(resolution.reason, 1024), inline: false })
                .setTimestamp();
            if (culpritMention && resolution.confidence !== "unknown") {
                embed.addFields({
                    name: resolution.confidence === "confirmed" ? "Responsável" : "Provável responsável",
                    value: `${culpritMention} (${executor?.id})`,
                    inline: false,
                });
            }
            const alertMsg = await sendLog(logChannel, {
                content: culpritMention && resolution.confidence !== "unknown" ? culpritMention : undefined,
                embeds: [embed],
            }, "deleted bot log alert");
            if (alertMsg)
                alertMessageIds.add(alertMsg.id);
            return;
        }
        if (message.channel.id === logChannel.id)
            return;
        if (message.author?.bot)
            return;
        const author = message.author ?? null;
        const content = wasPartial
            ? "[Conteúdo indisponível: a mensagem não estava no cache do bot]"
            : message.content || "[Sem conteúdo de texto]";
        const resolution = await resolveAuditLog(guild, {
            type: discord_js_1.AuditLogEvent.MessageDelete,
            targetId: author?.id,
            channelId: message.channel.id,
            allowProbable: !author?.id,
        });
        const executor = getExecutor(resolution);
        const executorMention = getExecutorMention(resolution);
        const footerText = buildMessageDeleteFooter(resolution, author?.id);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(executor && executor.id !== author?.id ? 0xff4757 : 0xe74c3c)
            .setTitle("📋 Mensagem Apagada")
            .addFields({
            name: "Autor",
            value: author ? formatUserId(author.id) : "Desconhecido (mensagem parcial ou fora do cache)",
            inline: false,
        }, {
            name: "Canal",
            value: `<#${message.channel.id}> (${message.channel.id})`,
            inline: false,
        }, {
            name: "ID da mensagem",
            value: message.id,
            inline: false,
        }, {
            name: "Conteúdo",
            value: formatCodeBlock(content),
            inline: false,
        }, {
            name: "Confiança do responsável",
            value: confidenceLabel(resolution.confidence),
            inline: true,
        })
            .setFooter({ text: footerText })
            .setTimestamp();
        if (author) {
            embed.setAuthor({
                name: author.tag,
                iconURL: author.displayAvatarURL({ size: 64 }),
            });
        }
        if (executorMention && resolution.confidence !== "unknown") {
            embed.addFields({
                name: executor?.id === author?.id ? "Responsável" : "Moderador responsável",
                value: `${executorMention} (${executor?.id})`,
                inline: false,
            });
        }
        const attachmentList = buildAttachmentList(message);
        if (attachmentList) {
            embed.addFields({ name: "📎 Anexos", value: attachmentList, inline: false });
        }
        await sendLog(logChannel, { embeds: [embed] }, "message delete");
    }
    catch (error) {
        console.error("[MESSAGE DELETE] Erro geral:", error);
    }
});
client.on(discord_js_1.Events.MessageBulkDelete, async (messages, channel) => {
    try {
        const guild = channel.guild ?? messages.first()?.guild;
        if (!guild)
            return;
        const logChannel = await getLogChannel(guild);
        if (!logChannel)
            return;
        if (channel.id === logChannel.id)
            return;
        const resolution = await resolveAuditLog(guild, {
            type: discord_js_1.AuditLogEvent.MessageBulkDelete,
            channelId: channel.id,
            allowProbable: true,
        });
        const executorMention = getExecutorMention(resolution);
        const deletedBy = executorMention
            ? `${executorMention} (${confidenceLabel(resolution.confidence)})`
            : `não identificado (${resolution.reason})`;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x8b0000)
            .setTitle("🗑️ Mensagens Deletadas em Massa")
            .setDescription(`**${messages.size}** mensagens deletadas em <#${channel.id}>.`)
            .addFields({ name: "Canal", value: `<#${channel.id}> (${channel.id})`, inline: false }, { name: "Responsável", value: deletedBy, inline: false }, { name: "Confiança", value: confidenceLabel(resolution.confidence), inline: true })
            .setFooter({ text: truncateText(resolution.reason, 2048) })
            .setTimestamp();
        await sendLog(logChannel, { embeds: [embed] }, "bulk delete");
    }
    catch (error) {
        console.error("[BULK DELETE] Erro geral:", error);
    }
});
client.on(discord_js_1.Events.MessageUpdate, async (oldMessage, newMessage) => {
    try {
        const oldContentUnavailable = oldMessage.partial;
        if (oldContentUnavailable) {
            console.log("[MSG EDIT] Conteúdo antigo indisponível: mensagem antiga parcial.");
        }
        if (newMessage.partial) {
            try {
                await newMessage.fetch();
            }
            catch {
                console.log("[MSG EDIT] Não foi possível buscar mensagem nova parcial.");
                return;
            }
        }
        const guild = newMessage.guild;
        if (!guild)
            return;
        const logChannel = await getLogChannel(guild);
        if (!logChannel)
            return;
        if (newMessage.author?.bot)
            return;
        if (newMessage.author?.id === client.user?.id)
            return;
        if (newMessage.channel.id === logChannel.id)
            return;
        const oldContent = oldContentUnavailable ? "[Não disponível no cache]" : oldMessage.content || "";
        const newContent = newMessage.content || "";
        if (oldContent === newContent)
            return;
        const author = newMessage.author;
        const authorMention = author ? `<@${author.id}>` : "Desconhecido";
        const authorDisplay = author ? author.tag : "Desconhecido";
        const createdUnix = newMessage.createdAt
            ? Math.floor(newMessage.createdAt.getTime() / 1000)
            : 0;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("✏️ Mensagem Editada")
            .addFields({
            name: "Autor",
            value: author ? `${authorMention} (${author.id})` : "Desconhecido",
            inline: false,
        }, {
            name: "Canal",
            value: `<#${newMessage.channel.id}> (${newMessage.channel.id})`,
            inline: false,
        }, { name: "ID da mensagem", value: newMessage.id, inline: false }, { name: "Link", value: `[Ir para a mensagem](${newMessage.url})`, inline: false }, {
            name: "📝 Antes",
            value: formatCodeBlock(oldContent || "[Sem conteúdo anterior]"),
            inline: false,
        }, {
            name: "✏️ Depois",
            value: formatCodeBlock(newContent || "[Sem conteúdo novo]"),
            inline: false,
        }, {
            name: "📅 Mensagem criada em",
            value: createdUnix ? `<t:${createdUnix}:F> (<t:${createdUnix}:R>)` : "Desconhecido",
            inline: false,
        })
            .setFooter({ text: `Editada pelo próprio autor: ${authorDisplay}` })
            .setTimestamp();
        if (author) {
            embed.setAuthor({
                name: `${author.displayName} (${author.tag})`,
                iconURL: author.displayAvatarURL({ size: 64 }),
            });
        }
        await sendLog(logChannel, { embeds: [embed] }, "message update");
    }
    catch (error) {
        console.error("[MESSAGE UPDATE] Erro geral:", error);
    }
});
async function cleanupOldLogs(readyClient) {
    if (cleanupRunning) {
        console.log("[AUTO CLEANUP] Limpeza já em andamento. Pulando execução sobreposta.");
        return;
    }
    cleanupRunning = true;
    console.log("[AUTO CLEANUP] Iniciando limpeza de logs antigas...");
    try {
        for (const guild of readyClient.guilds.cache.values()) {
            try {
                const logChannel = await getLogChannel(guild);
                if (!logChannel)
                    continue;
                const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
                const permissions = me ? logChannel.permissionsFor(me) : null;
                if (!permissions?.has(discord_js_1.PermissionFlagsBits.ManageMessages)) {
                    console.warn(`[AUTO CLEANUP] [${guild.name}] Sem Manage Messages em #${logChannel.name}. Pulando limpeza.`);
                    continue;
                }
                let totalDeleted = 0;
                let lastMessageId;
                let hasMore = true;
                while (hasMore) {
                    const fetchOptions = { limit: 100 };
                    if (lastMessageId)
                        fetchOptions.before = lastMessageId;
                    const messages = await logChannel.messages.fetch(fetchOptions);
                    if (messages.size === 0) {
                        hasMore = false;
                        break;
                    }
                    const lastMsg = messages.last();
                    if (lastMsg)
                        lastMessageId = lastMsg.id;
                    const now = Date.now();
                    const oldBotMessages = messages.filter((msg) => {
                        const age = now - msg.createdTimestamp;
                        return msg.author.id === readyClient.user.id && age > LOG_RETENTION_MS;
                    });
                    if (oldBotMessages.size === 0) {
                        if (lastMsg && now - lastMsg.createdTimestamp < LOG_RETENTION_MS) {
                            hasMore = false;
                        }
                        continue;
                    }
                    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
                    const bulkDeletable = oldBotMessages.filter((msg) => now - msg.createdTimestamp < fourteenDaysMs);
                    const tooOldForBulk = oldBotMessages.filter((msg) => now - msg.createdTimestamp >= fourteenDaysMs);
                    for (const [id] of oldBotMessages) {
                        autoDeletedMessageIds.add(id);
                    }
                    if (bulkDeletable.size >= 2) {
                        try {
                            await logChannel.bulkDelete(bulkDeletable);
                            totalDeleted += bulkDeletable.size;
                        }
                        catch (error) {
                            console.error("[AUTO CLEANUP] Erro no bulkDelete. Tentando delete individual:", error);
                            for (const [, msg] of bulkDeletable) {
                                try {
                                    await msg.delete();
                                    totalDeleted++;
                                    await delay(1000);
                                }
                                catch (deleteError) {
                                    console.error(`[AUTO CLEANUP] Erro ao deletar msg ${msg.id}:`, deleteError);
                                }
                            }
                        }
                    }
                    else if (bulkDeletable.size === 1) {
                        const msg = bulkDeletable.first();
                        try {
                            await msg.delete();
                            totalDeleted++;
                        }
                        catch (error) {
                            console.error(`[AUTO CLEANUP] Erro ao deletar msg ${msg.id}:`, error);
                        }
                    }
                    for (const [, msg] of tooOldForBulk) {
                        try {
                            await msg.delete();
                            totalDeleted++;
                            await delay(1000);
                        }
                        catch (error) {
                            console.error(`[AUTO CLEANUP] Erro ao deletar msg antiga ${msg.id}:`, error);
                        }
                    }
                    await delay(2000);
                }
                if (totalDeleted > 0) {
                    console.log(`[AUTO CLEANUP] [${guild.name}] ${totalDeleted} log(s) antiga(s) removida(s).`);
                }
                else {
                    console.log(`[AUTO CLEANUP] [${guild.name}] Nenhuma log antiga encontrada.`);
                }
            }
            catch (error) {
                console.error(`[AUTO CLEANUP] Erro no servidor ${guild.name}:`, error);
            }
        }
    }
    finally {
        cleanupRunning = false;
        console.log("[AUTO CLEANUP] Limpeza concluída.");
    }
}
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
    process.exit(1);
});
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error("❌ DISCORD_TOKEN não encontrado no .env!");
    console.error("   Crie um arquivo .env com: DISCORD_TOKEN=seu_token_aqui");
    process.exit(1);
}
client.login(token).catch((error) => {
    console.error("❌ Falha ao fazer login:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map