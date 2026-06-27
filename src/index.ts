import {
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Guild,
  GuildAuditLogsEntry,
  Message,
  Options,
  PartialMessage,
  Partials,
  PermissionFlagsBits,
  ReadonlyCollection,
  TextChannel,
  VoiceState,
} from "discord.js";
import { config } from "dotenv";

config();

type AuditConfidence = "confirmed" | "probable" | "unknown";

interface AuditResolution {
  confidence: AuditConfidence;
  entry: GuildAuditLogsEntry | null;
  candidates: number;
  reason: string;
}

interface AuditLookupOptions {
  type: AuditLogEvent;
  targetId?: string;
  channelId?: string;
  maxAgeMs?: number;
  retries?: number;
  initialDelayMs?: number;
  retryDelayMs?: number;
  allowProbable?: boolean;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
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

const logChannelCache = new Map<string, string>();
const voiceSessionStartTimes = new Map<string, number>();
let cleanupRunning = false;

class ExpiringIdSet {
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(private readonly defaultTtlMs: number) {}

  add(id: string, ttlMs = this.defaultTtlMs): void {
    this.delete(id);

    const timeout = setTimeout(() => {
      this.timeouts.delete(id);
    }, ttlMs);

    timeout.unref?.();
    this.timeouts.set(id, timeout);
  }

  consume(id: string): boolean {
    const timeout = this.timeouts.get(id);
    if (!timeout) return false;

    clearTimeout(timeout);
    this.timeouts.delete(id);
    return true;
  }

  delete(id: string): void {
    const timeout = this.timeouts.get(id);
    if (!timeout) return;

    clearTimeout(timeout);
    this.timeouts.delete(id);
  }
}

const autoDeletedMessageIds = new ExpiringIdSet(TRACKED_DELETE_TTL_MS);
const alertMessageIds = new ExpiringIdSet(TRACKED_DELETE_TTL_MS);

function readTextEnv(name: string, defaultValue: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : defaultValue;
}

function readSnowflakeEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;

  const match = value.match(/\d{17,20}/);
  if (!match) {
    console.warn(`[CONFIG] ${name} inválido. Usando fallback por nome de canal.`);
    return undefined;
  }

  return match[0];
}

function readIntegerEnv(
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[CONFIG] ${name} inválido (${raw}). Usando ${defaultValue}.`);
    return defaultValue;
  }

  if (parsed < min || parsed > max) {
    const clamped = Math.min(Math.max(parsed, min), max);
    console.warn(
      `[CONFIG] ${name} fora do intervalo ${min}-${max}. Usando ${clamped}.`
    );
    return clamped;
  }

  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(text: string, maxLength = 1024): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function escapeCodeBlock(text: string): string {
  return text.replace(/```/g, "`\u200b``");
}

function formatCodeBlock(
  text: string,
  emptyText = "[Sem conteúdo de texto]",
  maxLength = 1024
): string {
  const prefix = "```\n";
  const suffix = "\n```";
  const value = text.length > 0 ? text : emptyText;
  const maxBodyLength = Math.max(0, maxLength - prefix.length - suffix.length);
  return `${prefix}${truncateText(escapeCodeBlock(value), maxBodyLength)}${suffix}`;
}


function formatShortTime(date: Date = new Date()): string {
  return date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

function formatSimpleFooter(action: string): string {
  return `${action} • Hoje às ${formatShortTime()}`;
}

function formatAuthorName(user: { displayName?: string | null; username?: string; tag?: string }): string {
  return user.displayName || user.username || user.tag || "Desconhecido";
}

function formatVoiceChannel(guild: Guild, channelId: string): string {
  const channel = guild.channels.cache.get(channelId);
  if (channel?.name) return `**${channel.name}**`;
  return `<#${channelId}>`;
}

function formatTextChannel(channelId: string): string {
  return `<#${channelId}>`;
}


function getVoiceSessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function startVoiceSession(guildId: string, userId: string, startedAt: number = Date.now()): void {
  voiceSessionStartTimes.set(getVoiceSessionKey(guildId, userId), startedAt);
}

function ensureVoiceSession(guildId: string, userId: string): void {
  const key = getVoiceSessionKey(guildId, userId);
  if (!voiceSessionStartTimes.has(key)) {
    voiceSessionStartTimes.set(key, Date.now());
  }
}

function consumeVoiceSessionDuration(guildId: string, userId: string): number {
  const key = getVoiceSessionKey(guildId, userId);
  const startedAt = voiceSessionStartTimes.get(key) ?? Date.now();
  voiceSessionStartTimes.delete(key);
  return Math.max(1000, Date.now() - startedAt);
}

function formatDurationPart(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function joinDurationParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "1 segundo";
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

function formatVoiceDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    const parts = [formatDurationPart(hours, "hora", "horas")];
    if (minutes > 0) parts.push(formatDurationPart(minutes, "minuto", "minutos"));
    return joinDurationParts(parts);
  }

  if (minutes > 0) {
    const parts = [formatDurationPart(minutes, "minuto", "minutos")];
    if (seconds > 0) parts.push(formatDurationPart(seconds, "segundo", "segundos"));
    return joinDurationParts(parts);
  }

  return formatDurationPart(seconds, "segundo", "segundos");
}

function buildVoiceGossipDuration(durationMs: number): string {
  return `Ele ficou fofocando por ${formatVoiceDuration(durationMs)}.`;
}

function initializeActiveVoiceSessions(readyClient: Client<true>): void {
  const startedAt = Date.now();
  let trackedSessions = 0;

  for (const guild of readyClient.guilds.cache.values()) {
    for (const voiceState of guild.voiceStates.cache.values()) {
      const member = voiceState.member;
      if (!voiceState.channelId || !member || member.user.bot) continue;

      startVoiceSession(guild.id, member.user.id, startedAt);
      trackedSessions++;
    }
  }

  if (trackedSessions > 0) {
    console.log(`[VOICE] ${trackedSessions} sessão(ões) de voz ativa(s) rastreada(s) a partir do boot.`);
  }
}
function getExecutor(resolution: AuditResolution) {
  return resolution.entry?.executor ?? null;
}

function getExecutorMention(resolution: AuditResolution): string | null {
  const executor = getExecutor(resolution);
  return executor ? `<@${executor.id}>` : null;
}

function getExecutorDisplay(resolution: AuditResolution): string | null {
  const executor = getExecutor(resolution);
  if (!executor) return null;
  return executor.tag || executor.username || executor.id;
}

function getAuditEntryChannelId(entry: GuildAuditLogsEntry): string | null {
  const extra = entry.extra as
    | { channel?: { id?: string | null } | null; channelId?: string | null }
    | null
    | undefined;

  return extra?.channel?.id ?? extra?.channelId ?? null;
}

function entryDoesNotConflictWithChannel(
  entry: GuildAuditLogsEntry,
  channelId?: string
): boolean {
  if (!channelId) return true;

  const entryChannelId = getAuditEntryChannelId(entry);
  if (entryChannelId) return entryChannelId === channelId;
  if (entry.targetId === channelId) return true;

  return true;
}

function entryHasKnownChannelMatch(
  entry: GuildAuditLogsEntry,
  channelId?: string
): boolean {
  if (!channelId) return true;

  const entryChannelId = getAuditEntryChannelId(entry);
  if (entryChannelId) return entryChannelId === channelId;

  return entry.targetId === channelId;
}

function chooseEntryWithSingleExecutor(
  entries: GuildAuditLogsEntry[]
): GuildAuditLogsEntry | null {
  const executorIds = new Set(
    entries.map((entry) => entry.executor?.id).filter((id): id is string => Boolean(id))
  );

  if (executorIds.size !== 1) return null;

  const executorId = [...executorIds][0];
  return (
    entries
      .filter((entry) => entry.executor?.id === executorId)
      .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))[0] ?? null
  );
}

async function resolveAuditLog(
  guild: Guild,
  options: AuditLookupOptions
): Promise<AuditResolution> {
  const maxAgeMs = options.maxAgeMs ?? AUDIT_LOG_MAX_AGE_MS;
  const retries = options.retries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 700;
  const retryDelayMs = options.retryDelayMs ?? 700;
  let lastCandidates = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt === 0 && initialDelayMs > 0) {
      await delay(initialDelayMs);
    } else if (attempt > 0) {
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
        const targetCandidates = recent.filter(
          (entry) =>
            entry.targetId === options.targetId &&
            entryDoesNotConflictWithChannel(entry, options.channelId)
        );
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
        const knownChannelMatches = recent.filter((entry) =>
          entryHasKnownChannelMatch(entry, options.channelId)
        );
        const hasKnownChannelData = recent.some(
          (entry) => getAuditEntryChannelId(entry) || entry.targetId === options.channelId
        );
        const probableCandidates =
          options.channelId && hasKnownChannelData ? knownChannelMatches : recent;
        const selected = chooseEntryWithSingleExecutor(probableCandidates);

        if (selected) {
          return {
            confidence: "probable",
            entry: selected,
            candidates: probableCandidates.length,
            reason:
              "Audit log recente do mesmo tipo com executor único, mas sem alvo exato exposto pelo Discord.",
          };
        }
      }
    } catch (error) {
      console.error(
        `[AUDIT LOG] Erro ao buscar audit log (tentativa ${attempt + 1}/${retries + 1}):`,
        error
      );
    }
  }

  return {
    confidence: "unknown",
    entry: null,
    candidates: lastCandidates,
    reason: "Nenhuma entrada confiável foi encontrada na janela analisada.",
  };
}

async function resolveTextChannelById(
  guild: Guild,
  channelId: string
): Promise<TextChannel | null> {
  const cached = guild.channels.cache.get(channelId);
  if (cached?.type === ChannelType.GuildText) return cached as TextChannel;

  try {
    const fetched = await guild.channels.fetch(channelId);
    if (fetched?.type === ChannelType.GuildText) return fetched as TextChannel;
  } catch (error) {
    console.warn(`[LOG CHANNEL] Não consegui buscar o canal ${channelId} em ${guild.name}:`, error);
  }

  return null;
}

async function getLogChannel(guild: Guild): Promise<TextChannel | null> {
  const cachedId = logChannelCache.get(guild.id);
  if (cachedId) {
    const cachedChannel = await resolveTextChannelById(guild, cachedId);
    if (cachedChannel) return cachedChannel;
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
  const channelByName = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText && acceptedNames.has(channel.name)
  );

  if (channelByName?.type === ChannelType.GuildText) {
    logChannelCache.set(guild.id, channelByName.id);
    return channelByName as TextChannel;
  }

  return null;
}

async function sendLog(
  logChannel: TextChannel,
  payload: Parameters<TextChannel["send"]>[0],
  context: string
): Promise<Message<true> | null> {
  try {
    return await logChannel.send(payload);
  } catch (error) {
    console.error(`[SEND LOG] Falha ao enviar log (${context}):`, error);
    return null;
  }
}

async function validateLogChannel(guild: Guild): Promise<void> {
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
    } catch (error) {
      console.warn(`[READY] [${guild.name}] Não consegui buscar o membro do bot:`, error);
      return;
    }
  }

  const channelPermissions = logChannel.permissionsFor(me);
  const requiredChannelPermissions = [
    { flag: PermissionFlagsBits.ViewChannel, name: "View Channels" },
    { flag: PermissionFlagsBits.SendMessages, name: "Send Messages" },
    { flag: PermissionFlagsBits.EmbedLinks, name: "Embed Links" },
    { flag: PermissionFlagsBits.ReadMessageHistory, name: "Read Message History" },
  ];

  const missingChannelPermissions = requiredChannelPermissions
    .filter((permission) => !channelPermissions?.has(permission.flag))
    .map((permission) => permission.name);

  console.log(`  ✅ [${guild.name}] Canal de logs: #${logChannel.name} (${logChannel.id})`);

  if (missingChannelPermissions.length > 0) {
    console.warn(
      `  ⚠️ [${guild.name}] Permissões ausentes no canal de logs: ${missingChannelPermissions.join(
        ", "
      )}`
    );
  }

  if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    console.warn(
      `  ⚠️ [${guild.name}] Sem permissão View Audit Log. O bot continuará logando, mas identificará menos responsáveis.`
    );
  }

  if (!channelPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    console.warn(
      `  ⚠️ [${guild.name}] Sem Manage Messages em #${logChannel.name}. A limpeza automática pode falhar.`
    );
  }
}

function buildVoiceActorText(resolution: AuditResolution): string | null {
  return getExecutorMention(resolution);
}

client.once(Events.ClientReady, async (readyClient) => {
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

  setTimeout(() => {
    void cleanupOldLogs(readyClient);
  }, 30_000);

  setInterval(() => {
    void cleanupOldLogs(readyClient);
  }, 6 * 60 * 60 * 1000);

  console.log("  🧹 Limpeza automática agendada (a cada 6 horas)");
});

client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
  try {
    const guild = newState.guild || oldState.guild;
    const logChannel = await getLogChannel(guild);
    if (!logChannel) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const memberName = member.displayName || member.user.username;
    const memberMention = `<@${member.user.id}>`;
    const memberAvatar = member.user.displayAvatarURL({ size: 64 });

    if (!oldState.channelId && newState.channelId) {
      startVoiceSession(guild.id, member.user.id);

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setAuthor({ name: memberName, iconURL: memberAvatar })
        .setTitle("🎶 Entrada em Canal de Voz")
        .setDescription(
          `${memberMention} entrou no canal de voz ${formatVoiceChannel(guild, newState.channelId)}.`
        )
        .setTimestamp();

      await sendLog(logChannel, { embeds: [embed] }, "voice join");
      return;
    }

    if (oldState.channelId && !newState.channelId) {
      const durationMs = consumeVoiceSessionDuration(guild.id, member.user.id);
      const resolution = await resolveAuditLog(guild, {
        type: AuditLogEvent.MemberDisconnect,
        channelId: oldState.channelId,
        allowProbable: true,
      });
      const actorText = buildVoiceActorText(resolution);
      const wasDisconnectedByOther = actorText && getExecutor(resolution)?.id !== member.user.id;
      const channelText = formatVoiceChannel(guild, oldState.channelId);
      const description = wasDisconnectedByOther
        ? `${memberMention} foi desconectado de ${channelText} por ${actorText}.\n\n${buildVoiceGossipDuration(durationMs)}`
        : `${memberMention} saiu do canal de voz ${channelText}.\n\n${buildVoiceGossipDuration(durationMs)}`;

      const embed = new EmbedBuilder()
        .setColor(wasDisconnectedByOther ? 0xff6b6b : 0xe74c3c)
        .setAuthor({ name: memberName, iconURL: memberAvatar })
        .setTitle("🔇 Saída de Canal de Voz")
        .setDescription(description)
        .setTimestamp();

      await sendLog(logChannel, { embeds: [embed] }, "voice leave");
      return;
    }

    if (
      oldState.channelId &&
      newState.channelId &&
      oldState.channelId !== newState.channelId
    ) {
      ensureVoiceSession(guild.id, member.user.id);

      const resolution = await resolveAuditLog(guild, {
        type: AuditLogEvent.MemberMove,
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

      const embed = new EmbedBuilder()
        .setColor(wasMovedByOther ? 0xf39c12 : 0x3498db)
        .setAuthor({ name: memberName, iconURL: memberAvatar })
        .setTitle("🔀 Movido entre Canais de Voz")
        .setDescription(description)
        .setTimestamp();

      await sendLog(logChannel, { embeds: [embed] }, "voice move");
    }
  } catch (error) {
    console.error("[VOICE STATE UPDATE] Erro geral:", error);
  }
});
function buildMessageDeleteFooter(resolution: AuditResolution, authorId?: string): string {
  const executor = getExecutor(resolution);

  if (executor && resolution.confidence !== "unknown" && executor.id !== authorId) {
    return formatSimpleFooter(`Apagada por ${executor.username || executor.tag || executor.id}`);
  }

  if (authorId) {
    return formatSimpleFooter("Apagada pelo próprio autor");
  }

  return formatSimpleFooter("Responsável não identificado");
}

function buildAttachmentList(message: Message | PartialMessage): string | null {
  if (!message.attachments || message.attachments.size === 0) return null;

  const attachments = message.attachments.map((attachment) => {
    const name = attachment.name || "arquivo";
    return attachment.url ? `[${truncateText(name, 80)}](${attachment.url})` : name;
  });

  return truncateText(attachments.join("\n"), 1024);
}

const LOG_DELETE_RESPONSES = [
  (name: string) =>
    `🚨 **Epa, ${name}!** Pra que tá querendo apagar minhas logs? Tá aprontando né? Eu tô de olho em você. Vou salvar tudo, viu? Pare de aprontar, caba safado! 👀`,
  (name: string) =>
    `🕵️ **Log de auditoria registrada.** O(A) senhor(a) **${name}** tentou apagar uma log minha às ${formatShortTime()}. Acha que pode destruir provas? Eu SOU a prova. Tô de olho, safado(a)! 📋`,
];

function buildDeletedBotLogDescription(resolution: AuditResolution): string {
  const culprit = getExecutorDisplay(resolution) ?? "Algum espertinho";
  const randomIndex = Math.floor(Math.random() * LOG_DELETE_RESPONSES.length);
  return LOG_DELETE_RESPONSES[randomIndex](culprit);
}

client.on(Events.MessageDelete, async (message) => {
  try {
    const wasPartial = message.partial;
    if (wasPartial) {
      console.log(
        "[MSG DELETE] Mensagem parcial detectada. Conteúdo/autor podem estar indisponíveis porque a mensagem não estava em cache."
      );
    }

    const guild = message.guild;
    if (!guild) return;

    const logChannel = await getLogChannel(guild);
    if (!logChannel) return;

    if (
      message.author?.id === client.user?.id &&
      message.channel.id === logChannel.id
    ) {
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
        type: AuditLogEvent.MessageDelete,
        targetId: client.user?.id,
        channelId: logChannel.id,
        allowProbable: true,
      });
      const executor = getExecutor(resolution);

      if (executor?.id === client.user?.id) {
        console.log("[LOG PROTECTION] O próprio bot apagou a log. Ignorando.");
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("🚨 Log Apagada")
        .setDescription(buildDeletedBotLogDescription(resolution))
        .setFooter({ text: formatSimpleFooter("Ocorrência registrada") });

      const alertMsg = await sendLog(
        logChannel,
        { embeds: [embed] },
        "deleted bot log alert"
      );

      if (alertMsg) alertMessageIds.add(alertMsg.id);
      return;
    }

    if (message.channel.id === logChannel.id) return;
    if (message.author?.bot) return;

    const author = message.author ?? null;
    const content = wasPartial
      ? "[conteúdo indisponível]"
      : message.content || "[sem conteúdo de texto]";

    const resolution = await resolveAuditLog(guild, {
      type: AuditLogEvent.MessageDelete,
      targetId: author?.id,
      channelId: message.channel.id,
      allowProbable: !author?.id,
    });
    const executor = getExecutor(resolution);
    const footerText = buildMessageDeleteFooter(resolution, author?.id);

    const embed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle("🗑️ Mensagem Apagada")
      .setDescription(
        `**Autor:** ${author ? `<@${author.id}>` : "Desconhecido"}\n` +
          `**Canal:** ${formatTextChannel(message.channel.id)}`
      )
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
  } catch (error) {
    console.error("[MESSAGE DELETE] Erro geral:", error);
  }
});

client.on(
  Events.MessageBulkDelete,
  async (messages: ReadonlyCollection<string, Message<true> | PartialMessage<true>>, channel) => {
    try {
      const guild = (channel as { guild?: Guild }).guild ?? messages.first()?.guild;
      if (!guild) return;

      const logChannel = await getLogChannel(guild);
      if (!logChannel) return;
      if (channel.id === logChannel.id) return;

      const resolution = await resolveAuditLog(guild, {
        type: AuditLogEvent.MessageBulkDelete,
        channelId: channel.id,
        allowProbable: true,
      });
      const executorMention =
        resolution.confidence !== "unknown" ? getExecutorMention(resolution) : null;
      const responsibleText = executorMention ?? "Responsável não identificado";

      const embed = new EmbedBuilder()
        .setColor(0x8b0000)
        .setTitle("🗑️ Mensagens Deletadas em Massa")
        .setDescription(`**${messages.size}** mensagens foram apagadas em ${formatTextChannel(channel.id)}.`)
        .addFields({ name: "Responsável", value: responsibleText, inline: false })
        .setFooter({ text: formatSimpleFooter("Limpeza registrada") });

      await sendLog(logChannel, { embeds: [embed] }, "bulk delete");
    } catch (error) {
      console.error("[BULK DELETE] Erro geral:", error);
    }
  }
);

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    const oldContentUnavailable = oldMessage.partial;

    if (oldContentUnavailable) {
      console.log("[MSG EDIT] Conteúdo antigo indisponível: mensagem antiga parcial.");
    }

    if (newMessage.partial) {
      try {
        await newMessage.fetch();
      } catch {
        console.log("[MSG EDIT] Não foi possível buscar mensagem nova parcial.");
        return;
      }
    }

    const guild = newMessage.guild;
    if (!guild) return;

    const logChannel = await getLogChannel(guild);
    if (!logChannel) return;

    if (newMessage.author?.bot) return;
    if (newMessage.author?.id === client.user?.id) return;
    if (newMessage.channel.id === logChannel.id) return;

    const oldContent = oldContentUnavailable ? "[Não disponível no cache]" : oldMessage.content || "";
    const newContent = newMessage.content || "";
    if (oldContent === newContent) return;

    const author = newMessage.author;
    const authorMention = author ? `<@${author.id}>` : "Desconhecido";
    const authorDisplay = author ? formatAuthorName(author) : "Desconhecido";
    const authorUsername = author?.username || author?.tag || "Desconhecido";

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("✏️ Mensagem Editada")
      .setDescription(
        `**Autor:** ${author ? authorMention : "Desconhecido"}\n` +
          `**Canal:** ${formatTextChannel(newMessage.channel.id)}\n` +
          `**ID da Mensagem:** ${newMessage.id}\n` +
          `**[Ir para a mensagem](${newMessage.url})**`
      )
      .addFields(
        {
          name: "📝 Antes",
          value: formatCodeBlock(oldContent || "[Sem conteúdo anterior]"),
          inline: false,
        },
        {
          name: "✏️ Depois",
          value: formatCodeBlock(newContent || "[Sem conteúdo novo]"),
          inline: false,
        }
      )
      .setFooter({ text: formatSimpleFooter(`Editada por: ${authorUsername}`) });

    if (author) {
      embed.setAuthor({
        name: `${authorDisplay} (${authorUsername})`,
        iconURL: author.displayAvatarURL({ size: 64 }),
      });
    }

    await sendLog(logChannel, { embeds: [embed] }, "message update");
  } catch (error) {
    console.error("[MESSAGE UPDATE] Erro geral:", error);
  }
});

async function cleanupOldLogs(readyClient: Client<true>): Promise<void> {
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
        if (!logChannel) continue;

        const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
        const permissions = me ? logChannel.permissionsFor(me) : null;
        if (!permissions?.has(PermissionFlagsBits.ManageMessages)) {
          console.warn(
            `[AUTO CLEANUP] [${guild.name}] Sem Manage Messages em #${logChannel.name}. Pulando limpeza.`
          );
          continue;
        }

        let totalDeleted = 0;
        let lastMessageId: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const fetchOptions: { limit: number; before?: string } = { limit: 100 };
          if (lastMessageId) fetchOptions.before = lastMessageId;

          const messages = await logChannel.messages.fetch(fetchOptions);

          if (messages.size === 0) {
            hasMore = false;
            break;
          }

          const lastMsg = messages.last();
          if (lastMsg) lastMessageId = lastMsg.id;

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
          const bulkDeletable = oldBotMessages.filter(
            (msg) => now - msg.createdTimestamp < fourteenDaysMs
          );
          const tooOldForBulk = oldBotMessages.filter(
            (msg) => now - msg.createdTimestamp >= fourteenDaysMs
          );

          for (const [id] of oldBotMessages) {
            autoDeletedMessageIds.add(id);
          }

          if (bulkDeletable.size >= 2) {
            try {
              await logChannel.bulkDelete(bulkDeletable);
              totalDeleted += bulkDeletable.size;
            } catch (error) {
              console.error("[AUTO CLEANUP] Erro no bulkDelete. Tentando delete individual:", error);
              for (const [, msg] of bulkDeletable) {
                try {
                  await msg.delete();
                  totalDeleted++;
                  await delay(1000);
                } catch (deleteError) {
                  console.error(`[AUTO CLEANUP] Erro ao deletar msg ${msg.id}:`, deleteError);
                }
              }
            }
          } else if (bulkDeletable.size === 1) {
            const msg = bulkDeletable.first()!;
            try {
              await msg.delete();
              totalDeleted++;
            } catch (error) {
              console.error(`[AUTO CLEANUP] Erro ao deletar msg ${msg.id}:`, error);
            }
          }

          for (const [, msg] of tooOldForBulk) {
            try {
              await msg.delete();
              totalDeleted++;
              await delay(1000);
            } catch (error) {
              console.error(`[AUTO CLEANUP] Erro ao deletar msg antiga ${msg.id}:`, error);
            }
          }

          await delay(2000);
        }

        if (totalDeleted > 0) {
          console.log(
            `[AUTO CLEANUP] [${guild.name}] ${totalDeleted} log(s) antiga(s) removida(s).`
          );
        } else {
          console.log(`[AUTO CLEANUP] [${guild.name}] Nenhuma log antiga encontrada.`);
        }
      } catch (error) {
        console.error(`[AUTO CLEANUP] Erro no servidor ${guild.name}:`, error);
      }
    }
  } finally {
    cleanupRunning = false;
    console.log("[AUTO CLEANUP] Limpeza concluída.");
  }
}

client.on(Events.Error, (error) => {
  console.error("[DISCORD.JS ERROR]", error);
});

client.on(Events.Warn, (warning) => {
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
