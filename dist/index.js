"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const dotenv_1 = require("dotenv");
const logRetention_1 = require("./logRetention");
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
const LOG_RETENTION_DAYS = readIntegerEnv("LOG_RETENTION_DAYS", 7, 1, 90);
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const LOG_RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;
const DISCORD_BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const AUDIT_LOG_MAX_AGE_MS = 30_000;
const TRACKED_DELETE_TTL_MS = 10 * 60 * 1000;
const logChannelCache = new Map();
const voiceSessionStartTimes = new Map();
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
function isUnknownMessageError(error) {
    if (!error || typeof error !== "object" || !("code" in error))
        return false;
    return error.code === 10008;
}
const logRetentionManager = new logRetention_1.LogRetentionManager({
    retentionMs: LOG_RETENTION_MS,
    retryDelayMs: 60_000,
    markAutomaticDelete: (messageId) => autoDeletedMessageIds.add(messageId),
    unmarkAutomaticDelete: (messageId) => autoDeletedMessageIds.delete(messageId),
    isMissingMessageError: isUnknownMessageError,
    onDeleteError: (messageId, error) => {
        console.error(`[AUTO CLEANUP] Erro ao deletar msg ${messageId}. Nova tentativa em 60 segundos:`, error);
    },
});
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
function formatShortTime(date = new Date()) {
    return date.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
    });
}
function formatSimpleFooter(action) {
    return `${action} • Hoje às ${formatShortTime()}`;
}
function formatAuthorName(user) {
    return user.displayName || user.username || user.tag || "Desconhecido";
}
function formatVoiceChannel(guild, channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (channel?.name)
        return `**${channel.name}**`;
    return `<#${channelId}>`;
}
function formatTextChannel(channelId) {
    return `<#${channelId}>`;
}
function getVoiceSessionKey(guildId, userId) {
    return `${guildId}:${userId}`;
}
function startVoiceSession(guildId, userId, startedAt = Date.now()) {
    voiceSessionStartTimes.set(getVoiceSessionKey(guildId, userId), startedAt);
}
function ensureVoiceSession(guildId, userId) {
    const key = getVoiceSessionKey(guildId, userId);
    if (!voiceSessionStartTimes.has(key)) {
        voiceSessionStartTimes.set(key, Date.now());
    }
}
function consumeVoiceSessionDuration(guildId, userId) {
    const key = getVoiceSessionKey(guildId, userId);
    const startedAt = voiceSessionStartTimes.get(key) ?? Date.now();
    voiceSessionStartTimes.delete(key);
    return Math.max(1000, Date.now() - startedAt);
}
function formatDurationPart(value, singular, plural) {
    return `${value} ${value === 1 ? singular : plural}`;
}
function joinDurationParts(parts) {
    if (parts.length <= 1)
        return parts[0] ?? "1 segundo";
    return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}
function formatVoiceDuration(durationMs) {
    const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        const parts = [formatDurationPart(hours, "hora", "horas")];
        if (minutes > 0)
            parts.push(formatDurationPart(minutes, "minuto", "minutos"));
        return joinDurationParts(parts);
    }
    if (minutes > 0) {
        const parts = [formatDurationPart(minutes, "minuto", "minutos")];
        if (seconds > 0)
            parts.push(formatDurationPart(seconds, "segundo", "segundos"));
        return joinDurationParts(parts);
    }
    return formatDurationPart(seconds, "segundo", "segundos");
}
function buildVoiceGossipDuration(durationMs) {
    return `Ele ficou fofocando por ${formatVoiceDuration(durationMs)}.`;
}
function initializeActiveVoiceSessions(readyClient) {
    const startedAt = Date.now();
    let trackedSessions = 0;
    for (const guild of readyClient.guilds.cache.values()) {
        for (const voiceState of guild.voiceStates.cache.values()) {
            const member = voiceState.member;
            if (!voiceState.channelId || !member || member.user.bot)
                continue;
            startVoiceSession(guild.id, member.user.id, startedAt);
            trackedSessions++;
        }
    }
    if (trackedSessions > 0) {
        console.log(`[VOICE] ${trackedSessions} sessão(ões) de voz ativa(s) rastreada(s) a partir do boot.`);
    }
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
        const message = await logChannel.send(payload);
        logRetentionManager.schedule(message);
        return message;
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
        console.log(`  ℹ️ [${guild.name}] Sem Manage Messages em #${logChannel.name}. A limpeza usará exclusões individuais.`);
    }
}
function buildVoiceActorText(resolution) {
    return getExecutorMention(resolution);
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
    initializeActiveVoiceSessions(readyClient);
    void cleanupOldLogs(readyClient);
    setInterval(() => {
        void cleanupOldLogs(readyClient);
    }, LOG_RECONCILIATION_INTERVAL_MS);
    console.log("  🧹 Expiração individual ativa; reconciliação de segurança a cada 1 hora");
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
        const memberName = member.displayName || member.user.username;
        const memberMention = `<@${member.user.id}>`;
        const memberAvatar = member.user.displayAvatarURL({ size: 64 });
        if (!oldState.channelId && newState.channelId) {
            startVoiceSession(guild.id, member.user.id);
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x2ecc71)
                .setAuthor({ name: memberName, iconURL: memberAvatar })
                .setTitle("🎶 Entrada em Canal de Voz")
                .setDescription(`${memberMention} entrou no canal de voz ${formatVoiceChannel(guild, newState.channelId)}.`)
                .setTimestamp();
            await sendLog(logChannel, { embeds: [embed] }, "voice join");
            return;
        }
        if (oldState.channelId && !newState.channelId) {
            const durationMs = consumeVoiceSessionDuration(guild.id, member.user.id);
            const resolution = await resolveAuditLog(guild, {
                type: discord_js_1.AuditLogEvent.MemberDisconnect,
                channelId: oldState.channelId,
                allowProbable: true,
            });
            const actorText = buildVoiceActorText(resolution);
            const wasDisconnectedByOther = actorText && getExecutor(resolution)?.id !== member.user.id;
            const channelText = formatVoiceChannel(guild, oldState.channelId);
            const description = wasDisconnectedByOther
                ? `${memberMention} foi desconectado de ${channelText} por ${actorText}.\n\n${buildVoiceGossipDuration(durationMs)}`
                : `${memberMention} saiu do canal de voz ${channelText}.\n\n${buildVoiceGossipDuration(durationMs)}`;
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(wasDisconnectedByOther ? 0xff6b6b : 0xe74c3c)
                .setAuthor({ name: memberName, iconURL: memberAvatar })
                .setTitle("🔇 Saída de Canal de Voz")
                .setDescription(description)
                .setTimestamp();
            await sendLog(logChannel, { embeds: [embed] }, "voice leave");
            return;
        }
        if (oldState.channelId &&
            newState.channelId &&
            oldState.channelId !== newState.channelId) {
            ensureVoiceSession(guild.id, member.user.id);
            const resolution = await resolveAuditLog(guild, {
                type: discord_js_1.AuditLogEvent.MemberMove,
                channelId: newState.channelId,
                allowProbable: true,
            });
            const actorText = buildVoiceActorText(resolution);
            const wasMovedByOther = actorText && getExecutor(resolution)?.id !== member.user.id;
            const fromChannel = formatVoiceChannel(guild, oldState.channelId);
            const toChannel = formatVoiceChannel(guild, newState.channelId);
            const description = wasMovedByOther
                ? `${memberMention} foi movido por ${actorText} de ${fromChannel} para ${toChannel}. A fofoca deve estar boa.`
                : `${memberMention} se moveu de ${fromChannel} para ${toChannel}. Com certeza está aprontando.`;
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(wasMovedByOther ? 0xf39c12 : 0x3498db)
                .setAuthor({ name: memberName, iconURL: memberAvatar })
                .setTitle("🔀 Movido entre Canais de Voz")
                .setDescription(description)
                .setTimestamp();
            await sendLog(logChannel, { embeds: [embed] }, "voice move");
        }
    }
    catch (error) {
        console.error("[VOICE STATE UPDATE] Erro geral:", error);
    }
});
function buildMessageDeleteFooter(resolution, authorId) {
    const executor = getExecutor(resolution);
    if (executor && resolution.confidence !== "unknown" && executor.id !== authorId) {
        return formatSimpleFooter(`Apagada por ${executor.username || executor.tag || executor.id}`);
    }
    if (authorId) {
        return formatSimpleFooter("Apagada pelo próprio autor");
    }
    return formatSimpleFooter("Responsável não identificado");
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
const LOG_DELETE_RESPONSES = [
    (name) => `🚨 **Epa, ${name}!** Pra que tá querendo apagar minhas logs? Tá aprontando né? Eu tô de olho em você. Vou salvar tudo, viu? Pare de aprontar, caba safado! 👀`,
    (name) => `🕵️ **Log de auditoria registrada.** O(A) senhor(a) **${name}** tentou apagar uma log minha às ${formatShortTime()}. Acha que pode destruir provas? Eu SOU a prova. Tô de olho, safado(a)! 📋`,
];
function buildDeletedBotLogDescription(resolution) {
    const culprit = getExecutorDisplay(resolution) ?? "Algum espertinho";
    const randomIndex = Math.floor(Math.random() * LOG_DELETE_RESPONSES.length);
    return LOG_DELETE_RESPONSES[randomIndex](culprit);
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
            logRetentionManager.cancel(message.id);
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
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0xff0000)
                .setTitle("🚨 Log Apagada")
                .setDescription(buildDeletedBotLogDescription(resolution))
                .setFooter({ text: formatSimpleFooter("Ocorrência registrada") });
            const alertMsg = await sendLog(logChannel, { embeds: [embed] }, "deleted bot log alert");
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
            ? "[conteúdo indisponível]"
            : message.content || "[sem conteúdo de texto]";
        const resolution = await resolveAuditLog(guild, {
            type: discord_js_1.AuditLogEvent.MessageDelete,
            targetId: author?.id,
            channelId: message.channel.id,
            allowProbable: !author?.id,
        });
        const executor = getExecutor(resolution);
        const footerText = buildMessageDeleteFooter(resolution, author?.id);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle("🗑️ Mensagem Apagada")
            .setDescription(`**Autor:** ${author ? `<@${author.id}>` : "Desconhecido"}\n` +
            `**Canal:** ${formatTextChannel(message.channel.id)}`)
            .addFields({
            name: "📝 Conteúdo",
            value: formatCodeBlock(content),
            inline: false,
        })
            .setFooter({ text: footerText });
        if (author) {
            embed.setAuthor({
                name: formatAuthorName(author),
                iconURL: author.displayAvatarURL({ size: 64 }),
            });
        }
        if (executor && resolution.confidence !== "unknown" && executor.id !== author?.id) {
            embed.addFields({
                name: "🔍 Apagada por",
                value: `<@${executor.id}>`,
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
        const executorMention = resolution.confidence !== "unknown" ? getExecutorMention(resolution) : null;
        const responsibleText = executorMention ?? "Responsável não identificado";
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x8b0000)
            .setTitle("🗑️ Mensagens Deletadas em Massa")
            .setDescription(`**${messages.size}** mensagens foram apagadas em ${formatTextChannel(channel.id)}.`)
            .addFields({ name: "Responsável", value: responsibleText, inline: false })
            .setFooter({ text: formatSimpleFooter("Limpeza registrada") });
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
        const authorDisplay = author ? formatAuthorName(author) : "Desconhecido";
        const authorUsername = author?.username || author?.tag || "Desconhecido";
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("✏️ Mensagem Editada")
            .setDescription(`**Autor:** ${author ? authorMention : "Desconhecido"}\n` +
            `**Canal:** ${formatTextChannel(newMessage.channel.id)}\n` +
            `**ID da Mensagem:** ${newMessage.id}\n` +
            `**[Ir para a mensagem](${newMessage.url})**`)
            .addFields({
            name: "📝 Antes",
            value: formatCodeBlock(oldContent || "[Sem conteúdo anterior]"),
            inline: false,
        }, {
            name: "✏️ Depois",
            value: formatCodeBlock(newContent || "[Sem conteúdo novo]"),
            inline: false,
        })
            .setFooter({ text: formatSimpleFooter(`Editada por: ${authorUsername}`) });
        if (author) {
            embed.setAuthor({
                name: `${authorDisplay} (${authorUsername})`,
                iconURL: author.displayAvatarURL({ size: 64 }),
            });
        }
        await sendLog(logChannel, { embeds: [embed] }, "message update");
    }
    catch (error) {
        console.error("[MESSAGE UPDATE] Erro geral:", error);
    }
});
async function deleteExpiredBotMessages(logChannel, expiredMessages, canBulkDelete) {
    const now = Date.now();
    const bulkEligible = expiredMessages.filter((message) => now - message.createdTimestamp < DISCORD_BULK_DELETE_MAX_AGE_MS);
    const individualMessages = expiredMessages.filter((message) => now - message.createdTimestamp >= DISCORD_BULK_DELETE_MAX_AGE_MS);
    let deletedCount = 0;
    if (canBulkDelete && bulkEligible.length >= 2) {
        for (const message of bulkEligible) {
            logRetentionManager.cancel(message.id);
            autoDeletedMessageIds.add(message.id);
        }
        try {
            await logChannel.bulkDelete(bulkEligible);
            deletedCount += bulkEligible.length;
        }
        catch (error) {
            console.error("[AUTO CLEANUP] Erro no bulkDelete. Tentando exclusão individual:", error);
            for (const message of bulkEligible) {
                autoDeletedMessageIds.delete(message.id);
            }
            individualMessages.push(...bulkEligible);
        }
    }
    else {
        individualMessages.push(...bulkEligible);
    }
    for (const message of individualMessages) {
        if (await logRetentionManager.deleteNow(message)) {
            deletedCount++;
        }
    }
    return deletedCount;
}
async function cleanupOldLogs(readyClient) {
    if (cleanupRunning) {
        console.log("[AUTO CLEANUP] Limpeza já em andamento. Pulando execução sobreposta.");
        return;
    }
    cleanupRunning = true;
    console.log("[AUTO CLEANUP] Reconciliando retenção das logs...");
    try {
        for (const guild of readyClient.guilds.cache.values()) {
            try {
                const logChannel = await getLogChannel(guild);
                if (!logChannel)
                    continue;
                const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
                const permissions = me ? logChannel.permissionsFor(me) : null;
                const canBulkDelete = permissions?.has(discord_js_1.PermissionFlagsBits.ManageMessages) ?? false;
                let totalDeleted = 0;
                let totalScheduled = 0;
                await (0, logRetention_1.walkMessageHistory)({
                    fetchPage: async (before) => {
                        const fetchOptions = { limit: 100 };
                        if (before)
                            fetchOptions.before = before;
                        const messages = await logChannel.messages.fetch(fetchOptions);
                        return [...messages.values()];
                    },
                    handlePage: async (messages) => {
                        const { active: activeMessages, expired: expiredMessages } = (0, logRetention_1.partitionOwnedMessages)(messages, readyClient.user.id, Date.now(), LOG_RETENTION_MS);
                        for (const message of activeMessages) {
                            if (!logRetentionManager.isScheduled(message.id)) {
                                totalScheduled++;
                            }
                            logRetentionManager.schedule(message);
                        }
                        totalDeleted += await deleteExpiredBotMessages(logChannel, expiredMessages, canBulkDelete);
                    },
                });
                console.log(`[AUTO CLEANUP] [${guild.name}] ${totalDeleted} removida(s), ${totalScheduled} agendada(s).`);
            }
            catch (error) {
                console.error(`[AUTO CLEANUP] Erro no servidor ${guild.name}:`, error);
            }
        }
    }
    finally {
        cleanupRunning = false;
        console.log("[AUTO CLEANUP] Reconciliação concluída.");
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