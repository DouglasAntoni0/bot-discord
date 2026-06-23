import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  EmbedBuilder,
  AuditLogEvent,
  VoiceState,
  Message,
  Guild,
  GuildAuditLogsEntry,
  ChannelType,
  Events,
  ReadonlyCollection,
  PartialMessage,
} from "discord.js";
import { config } from "dotenv";

config();

// ─────────────────────────────────────────────────────────────────────────────
// Configuração do cliente com TODAS as intents e partials necessárias
// ─────────────────────────────────────────────────────────────────────────────
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
    Partials.Message,    // Para capturar mensagens que não estão em cache
    Partials.Channel,    // Para capturar canais parciais
    Partials.GuildMember,// Para capturar membros parciais
    Partials.User,       // Para capturar users parciais
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
function getLogChannel(guild: Guild): TextChannel | null {
  const channel = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      (ch.name === LOG_CHANNEL_NAME ||
        ch.name === "📜logs" ||
        ch.name === "logs" ||
        ch.name === "📜-logs" ||
        ch.name === "📜│logs")
  );

  if (channel && channel.type === ChannelType.GuildText) {
    return channel as TextChannel;
  }

  return null;
}

/**
 * Formata timestamp para o Discord (formato relativo e absoluto)
 */
function formatTimestamp(date: Date = new Date()): string {
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

/**
 * Trunca texto para caber no embed (máximo 1024 chars por field)
 */
function truncateText(text: string, maxLength: number = 1024): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Busca entradas recentes no Audit Log com retry robusto.
 * Usa múltiplas tentativas com backoff progressivo para garantir
 * que o audit log tenha tempo de ser registrado pelo Discord.
 */
async function fetchAuditLog(
  guild: Guild,
  type: AuditLogEvent,
  targetId?: string,
  retries: number = 4
): Promise<GuildAuditLogsEntry | null> {
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
          if (timeDiff > 30000) return false; // 30 segundos de janela
          return e.targetId === targetId;
        });
        if (exactMatch) return exactMatch;
      }

      // Segunda passagem: buscar qualquer entrada recente do mesmo tipo
      const recentMatch = auditLogs.entries.find((e) => {
        const timeDiff = now - (e.createdTimestamp || 0);
        return timeDiff <= 30000; // 30 segundos de janela
      });

      if (recentMatch) return recentMatch;
    } catch (error) {
      console.error(
        `[AUDIT LOG] Erro ao buscar audit log (tentativa ${attempt + 1}/${retries + 1}):`,
        error
      );
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evento: Bot pronto
// ─────────────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, (readyClient) => {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`✅ Bot conectado como: ${readyClient.user.tag}`);
  console.log(`📊 Servidores: ${readyClient.guilds.cache.size}`);
  console.log(`📋 Canal de logs: ${LOG_CHANNEL_NAME}`);
  console.log("═══════════════════════════════════════════════════════");

  // Verificar canais de log em todos os servidores
  readyClient.guilds.cache.forEach((guild) => {
    const logChannel = getLogChannel(guild);
    if (logChannel) {
      console.log(
        `  ✅ [${guild.name}] Canal de logs encontrado: #${logChannel.name}`
      );
    } else {
      console.warn(
        `  ⚠️ [${guild.name}] Canal de logs "${LOG_CHANNEL_NAME}" NÃO encontrado!`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evento: Voice State Update (entrar, sair, mover de call)
// ─────────────────────────────────────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const logChannel = getLogChannel(guild);
    if (!logChannel) return;

    const member = newState.member || oldState.member;
    if (!member) return;

    // Ignorar bots
    if (member.user.bot) return;

    const memberTag = `${member.user.tag}`;
    const memberMention = `<@${member.user.id}>`;
    const memberAvatar = member.user.displayAvatarURL({ size: 64 });

    // ── ENTROU EM UMA CALL ──
    if (!oldState.channelId && newState.channelId) {
      const embed = new EmbedBuilder()
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
      let disconnectedBy: string | null = null;

      // Delay para dar tempo do audit log ser registrado
      await new Promise((resolve) => setTimeout(resolve, 500));

      try {
        // Tentativa 1: buscar pelo targetId do membro
        let entry = await fetchAuditLog(
          guild,
          AuditLogEvent.MemberDisconnect,
          member.user.id
        );

        // Tentativa 2: buscar sem targetId (fallback - MemberDisconnect nem sempre tem targetId)
        if (!entry) {
          entry = await fetchAuditLog(
            guild,
            AuditLogEvent.MemberDisconnect
          );
        }

        if (entry && entry.executor && entry.executor.id !== member.user.id) {
          disconnectedBy = `<@${entry.executor.id}>`;
        }
      } catch (err) {
        console.error("[VOICE] Erro ao verificar audit log de disconnect:", err);
      }

      const embed = new EmbedBuilder()
        .setAuthor({ name: memberTag, iconURL: memberAvatar })
        .setTimestamp();

      if (disconnectedBy) {
        embed
          .setColor(0xff6b6b)
          .setTitle("🔇 Desconectado de Canal de Voz")
          .setDescription(`${memberMention} foi desconectado do canal de voz <#${oldState.channelId}> por ${disconnectedBy}.`);
      } else {
        embed
          .setColor(0xe74c3c)
          .setTitle("🔇 Saída de Canal de Voz")
          .setDescription(`${memberMention} saiu do canal de voz <#${oldState.channelId}>.`);
      }

      await logChannel.send({ embeds: [embed] });
      return;
    }

    // ── MOVIDO DE CALL ──
    if (
      oldState.channelId &&
      newState.channelId &&
      oldState.channelId !== newState.channelId
    ) {
      // Verificar no audit log quem moveu (detecção robusta)
      let movedBy: string | null = null;

      // Delay para dar tempo do audit log ser registrado
      await new Promise((resolve) => setTimeout(resolve, 500));

      try {
        // Tentativa 1: buscar pelo targetId do membro
        let entry = await fetchAuditLog(
          guild,
          AuditLogEvent.MemberMove,
          member.user.id
        );

        // Tentativa 2: buscar sem targetId (fallback)
        if (!entry) {
          entry = await fetchAuditLog(
            guild,
            AuditLogEvent.MemberMove
          );
        }

        if (entry && entry.executor && entry.executor.id !== member.user.id) {
          movedBy = `<@${entry.executor.id}>`;
        }
      } catch (err) {
        console.error("[VOICE] Erro ao verificar audit log de move:", err);
      }

      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setAuthor({ name: memberTag, iconURL: memberAvatar })
        .setTimestamp();

      if (movedBy) {
        embed
          .setTitle("🔀 Movido entre Canais de Voz")
          .setDescription(`${memberMention} foi movido de <#${oldState.channelId}> para <#${newState.channelId}> por ${movedBy}.`);
      } else {
        embed
          .setTitle("🔀 Movido entre Canais de Voz")
          .setDescription(`${memberMention} se moveu de <#${oldState.channelId}> para <#${newState.channelId}>.`);
      }

      await logChannel.send({ embeds: [embed] });
      return;
    }
  } catch (error) {
    console.error("[VOICE STATE UPDATE] Erro geral:", error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Evento: Mensagem Deletada
// ─────────────────────────────────────────────────────────────────────────────
client.on(Events.MessageDelete, async (message) => {
  try {
    // Tentar fazer fetch do partial
    if (message.partial) {
      try {
        console.log(
          "[MSG DELETE] Mensagem parcial detectada - usando dados do cache"
        );
      } catch {
        console.log("[MSG DELETE] Não foi possível recuperar mensagem parcial");
        return;
      }
    }

    const guild = message.guild;
    if (!guild) return;

    const logChannel = getLogChannel(guild);
    if (!logChannel) return;

    // Ignorar mensagens do próprio bot e do canal de logs
    if (message.author?.id === client.user?.id) return;
    if (message.channel.id === logChannel.id) return;

    // Ignorar bots
    if (message.author?.bot) return;

    const author = message.author;
    const content = message.content || "*[Sem conteúdo de texto]*";

    // ── Verificar quem deletou via Audit Log (detecção robusta) ──
    let deletedByTag: string | null = null;
    let selfDeleted = true;

    // Delay inicial para dar tempo do Discord registrar no audit log
    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      // Tentativa 1: buscar pelo targetId do autor
      let entry = await fetchAuditLog(
        guild,
        AuditLogEvent.MessageDelete,
        author?.id
      );

      // Tentativa 2: se não encontrou, buscar sem targetId (fallback)
      if (!entry) {
        entry = await fetchAuditLog(
          guild,
          AuditLogEvent.MessageDelete
        );
      }

      if (entry && entry.executor && author) {
        if (entry.executor.id !== author.id) {
          deletedByTag = entry.executor.tag || `<@${entry.executor.id}>`;
          selfDeleted = false;
        }
      }
    } catch (err) {
      console.error("[MSG DELETE] Erro ao verificar audit log:", err);
    }

    // ── Montar embed no estilo da foto ──
    const authorMention = author ? `<@${author.id}>` : "*Desconhecido*";
    const channelMention = `<#${message.channel.id}>`;

    // Footer com quem deletou
    let footerText: string;
    if (selfDeleted) {
      footerText = "Apagada pelo próprio autor";
    } else {
      footerText = `Apagada por ${deletedByTag}`;
    }

    const embed = new EmbedBuilder()
      .setColor(selfDeleted ? 0xe74c3c : 0xff4757)
      .setTitle("📋 Mensagem Apagada")
      .addFields(
        {
          name: "Autor:",
          value: authorMention,
          inline: true,
        },
        {
          name: "Canal:",
          value: channelMention,
          inline: true,
        },
        {
          name: "📋 Conteúdo",
          value: truncateText(`\`\`\`\n${content}\n\`\`\``, 1024),
          inline: false,
        }
      )
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
  } catch (error) {
    console.error("[MESSAGE DELETE] Erro geral:", error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Evento: Mensagens Deletadas em Bulk
// ─────────────────────────────────────────────────────────────────────────────
client.on(
  Events.MessageBulkDelete,
  async (messages: ReadonlyCollection<string, Message<true> | PartialMessage<true>>, channel) => {
    try {
      const firstMsg = messages.first();
      const guild = firstMsg?.guild;
      if (!guild) return;

      const logChannel = getLogChannel(guild);
      if (!logChannel) return;
      if (channel.id === logChannel.id) return;

      // Verificar quem deletou em massa
      let deletedBy: string = "*Desconhecido*";
      try {
        const entry = await fetchAuditLog(
          guild,
          AuditLogEvent.MessageBulkDelete
        );
        if (entry && entry.executor) {
          deletedBy = `<@${entry.executor.id}>`;
        }
      } catch (err) {
        console.error("[BULK DELETE] Erro ao verificar audit log:", err);
      }

      const embed = new EmbedBuilder()
        .setColor(0x8b0000)
        .setTitle("🗑️ Mensagens Deletadas em Massa")
        .setDescription(`**${messages.size}** mensagens deletadas em <#${channel.id}> por ${deletedBy}.`)
        .setTimestamp();

      await logChannel.send({ embeds: [embed] });
    } catch (error) {
      console.error("[BULK DELETE] Erro geral:", error);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Evento: Mensagem Editada
// ─────────────────────────────────────────────────────────────────────────────
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    // Tentar resolver partials
    if (oldMessage.partial) {
      try {
        await oldMessage.fetch();
      } catch {
        console.log("[MSG EDIT] Não foi possível buscar mensagem antiga parcial");
      }
    }

    if (newMessage.partial) {
      try {
        await newMessage.fetch();
      } catch {
        console.log("[MSG EDIT] Não foi possível buscar mensagem nova parcial");
        return;
      }
    }

    const guild = newMessage.guild;
    if (!guild) return;

    const logChannel = getLogChannel(guild);
    if (!logChannel) return;

    // Ignorar bots
    if (newMessage.author?.bot) return;

    // Ignorar o próprio bot
    if (newMessage.author?.id === client.user?.id) return;

    // Ignorar canal de logs
    if (newMessage.channel.id === logChannel.id) return;

    // Ignorar se o conteúdo não mudou (pode ser update de embed/attachment)
    const oldContent = oldMessage.content || "";
    const newContent = newMessage.content || "";
    if (oldContent === newContent) return;

    const author = newMessage.author;
    const authorMention = author ? `<@${author.id}>` : "*Desconhecido*";
    const authorDisplay = author ? `${author.tag}` : "Desconhecido";

    // Data de criação da mensagem
    const createdAt = newMessage.createdAt;
    const createdUnix = createdAt ? Math.floor(createdAt.getTime() / 1000) : 0;

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("✏️ Mensagem Editada")
      .addFields(
        {
          name: "Autor:",
          value: `${authorMention} ( ${author?.id || "N/A"} )`,
          inline: true,
        },
        {
          name: "Canal:",
          value: `<#${newMessage.channel.id}>`,
          inline: true,
        },
        {
          name: "ID da Mensagem:",
          value: `${newMessage.id}`,
          inline: false,
        },
        {
          name: "\u200b",
          value: `[Ir para a mensagem](${newMessage.url})`,
          inline: false,
        },
        {
          name: "📝 Antes",
          value: truncateText(`\`\`\`\n${oldContent || "[Não disponível]"}\n\`\`\``, 1024),
          inline: false,
        },
        {
          name: "✏️ Depois",
          value: truncateText(`\`\`\`\n${newContent || "[Sem conteúdo]"}\n\`\`\``, 1024),
          inline: false,
        },
        {
          name: "📅 Mensagem criada em",
          value: createdUnix ? `<t:${createdUnix}:F> ( <t:${createdUnix}:R> )` : "*Desconhecido*",
          inline: false,
        }
      )
      .setFooter({ text: `Editada por: ${authorDisplay}` })
      .setTimestamp();

    if (author) {
      embed.setAuthor({
        name: `${author.displayName} (${author.tag})`,
        iconURL: author.displayAvatarURL({ size: 64 }),
      });
    }

    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error("[MESSAGE UPDATE] Erro geral:", error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tratamento de erros globais
// ─────────────────────────────────────────────────────────────────────────────
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
