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
 * Busca entradas recentes no Audit Log com retry
 */
async function fetchAuditLog(
  guild: Guild,
  type: AuditLogEvent,
  targetId?: string,
  retries: number = 2
): Promise<GuildAuditLogsEntry | null> {
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
        if (timeDiff > 10000) return false;

        // Se temos targetId, verificar se bate
        if (targetId && e.targetId !== targetId) return false;

        return true;
      });

      if (entry) return entry;
    } catch (error) {
      console.error(
        `[AUDIT LOG] Erro ao buscar audit log (tentativa ${attempt + 1}):`,
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
        .setColor(0x2ecc71) // Verde
        .setAuthor({ name: memberTag, iconURL: memberAvatar })
        .setTitle("🎙️ Entrou em um canal de voz")
        .addFields(
          {
            name: "👤 Membro",
            value: memberMention,
            inline: true,
          },
          {
            name: "🔊 Canal",
            value: `<#${newState.channelId}>`,
            inline: true,
          },
          {
            name: "🕐 Horário",
            value: formatTimestamp(),
            inline: false,
          }
        )
        .setFooter({ text: `ID: ${member.user.id}` })
        .setTimestamp();

      await logChannel.send({ embeds: [embed] });
      return;
    }

    // ── SAIU DE UMA CALL ──
    if (oldState.channelId && !newState.channelId) {
      // Verificar no audit log se foi desconectado por alguém
      let disconnectedBy: string | null = null;

      try {
        const entry = await fetchAuditLog(
          guild,
          AuditLogEvent.MemberDisconnect,
          undefined // MemberDisconnect nem sempre tem targetId confiável
        );

        if (entry && entry.executor && entry.executor.id !== member.user.id) {
          disconnectedBy = `<@${entry.executor.id}> (${entry.executor.tag})`;
        }
      } catch (err) {
        console.error("[VOICE] Erro ao verificar audit log de disconnect:", err);
      }

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c) // Vermelho
        .setAuthor({ name: memberTag, iconURL: memberAvatar })
        .setTitle("🔇 Saiu de um canal de voz")
        .addFields(
          {
            name: "👤 Membro",
            value: memberMention,
            inline: true,
          },
          {
            name: "🔊 Canal",
            value: `<#${oldState.channelId}>`,
            inline: true,
          },
          {
            name: "🕐 Horário",
            value: formatTimestamp(),
            inline: false,
          }
        )
        .setFooter({ text: `ID: ${member.user.id}` })
        .setTimestamp();

      if (disconnectedBy) {
        embed.addFields({
          name: "⚠️ Desconectado por",
          value: disconnectedBy,
          inline: false,
        });
        embed.setTitle("🔇 Foi desconectado de um canal de voz");
        embed.setColor(0xff6b6b);
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
      // Verificar no audit log quem moveu
      let movedBy: string | null = null;
      let selfMoved = true;

      try {
        const entry = await fetchAuditLog(
          guild,
          AuditLogEvent.MemberMove,
          undefined
        );

        if (entry && entry.executor) {
          if (entry.executor.id !== member.user.id) {
            movedBy = `<@${entry.executor.id}> (${entry.executor.tag})`;
            selfMoved = false;
          }
        }
      } catch (err) {
        console.error("[VOICE] Erro ao verificar audit log de move:", err);
      }

      const embed = new EmbedBuilder()
        .setColor(0xf39c12) // Amarelo/Laranja
        .setAuthor({ name: memberTag, iconURL: memberAvatar })
        .setTitle(
          selfMoved
            ? "🔀 Mudou de canal de voz"
            : "🔀 Foi movido de canal de voz"
        )
        .addFields(
          {
            name: "👤 Membro",
            value: memberMention,
            inline: true,
          },
          {
            name: "📤 De",
            value: `<#${oldState.channelId}>`,
            inline: true,
          },
          {
            name: "📥 Para",
            value: `<#${newState.channelId}>`,
            inline: true,
          },
          {
            name: "🕐 Horário",
            value: formatTimestamp(),
            inline: false,
          }
        )
        .setFooter({ text: `ID: ${member.user.id}` })
        .setTimestamp();

      if (movedBy) {
        embed.addFields({
          name: "👮 Movido por",
          value: movedBy,
          inline: false,
        });
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
        // Mensagens deletadas parciais não podem ser fetched,
        // mas tentamos usar o que está em cache
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
    const channelMention = `<#${message.channel.id}>`;

    // Verificar quem deletou via Audit Log
    let deletedBy: string | null = null;
    let selfDeleted = true;

    // Pequeno delay para o audit log ser registrado
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const entry = await fetchAuditLog(
        guild,
        AuditLogEvent.MessageDelete,
        author?.id
      );

      if (entry && entry.executor && author) {
        if (entry.executor.id !== author.id) {
          deletedBy = `<@${entry.executor.id}> (${entry.executor.tag})`;
          selfDeleted = false;
        }
      }
    } catch (err) {
      console.error("[MSG DELETE] Erro ao verificar audit log:", err);
    }

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c) // Vermelho
      .setTitle("🗑️ Mensagem Deletada")
      .addFields(
        {
          name: "👤 Autor da mensagem",
          value: author ? `<@${author.id}> (${author.tag})` : "*Desconhecido*",
          inline: true,
        },
        {
          name: "📌 Canal",
          value: channelMention,
          inline: true,
        },
        {
          name: "📝 Conteúdo",
          value: truncateText(content),
          inline: false,
        }
      )
      .setFooter({
        text: `ID da mensagem: ${message.id} | ID do autor: ${author?.id || "N/A"}`,
      })
      .setTimestamp();

    // Quem deletou
    if (selfDeleted) {
      embed.addFields({
        name: "🗑️ Deletada por",
        value: "A própria pessoa",
        inline: false,
      });
    } else if (deletedBy) {
      embed.addFields({
        name: "👮 Deletada por",
        value: deletedBy,
        inline: false,
      });
      embed.setColor(0xff4757); // Vermelho mais vivo
    }

    // Se tinha anexos
    if (message.attachments && message.attachments.size > 0) {
      const attachmentList = message.attachments
        .map(
          (att) =>
            `[${att.name || "arquivo"}](${att.proxyURL || att.url}) (${att.contentType || "desconhecido"})`
        )
        .join("\n");
      embed.addFields({
        name: "📎 Anexos",
        value: truncateText(attachmentList),
        inline: false,
      });
    }

    // Se tinha embeds
    if (message.embeds && message.embeds.length > 0) {
      embed.addFields({
        name: "📦 Embeds",
        value: `${message.embeds.length} embed(s) na mensagem`,
        inline: true,
      });
    }

    // Se tinha stickers
    if (message.stickers && message.stickers.size > 0) {
      const stickerList = message.stickers.map((s) => s.name).join(", ");
      embed.addFields({
        name: "🏷️ Stickers",
        value: stickerList,
        inline: true,
      });
    }

    embed.addFields({
      name: "🕐 Horário da exclusão",
      value: formatTimestamp(),
      inline: false,
    });

    if (author) {
      embed.setAuthor({
        name: author.tag,
        iconURL: author.displayAvatarURL({ size: 64 }),
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
          deletedBy = `<@${entry.executor.id}> (${entry.executor.tag})`;
        }
      } catch (err) {
        console.error("[BULK DELETE] Erro ao verificar audit log:", err);
      }

      const messageList = messages
        .map((msg) => {
          const author = msg.author
            ? `${msg.author.tag}`
            : "Desconhecido";
          const content = msg.content || "[sem conteúdo]";
          return `**${author}:** ${content}`;
        })
        .reverse()
        .join("\n");

      const embed = new EmbedBuilder()
        .setColor(0x8b0000) // Vermelho escuro
        .setTitle("🗑️ Mensagens Deletadas em Massa")
        .addFields(
          {
            name: "📌 Canal",
            value: `<#${channel.id}>`,
            inline: true,
          },
          {
            name: "📊 Quantidade",
            value: `${messages.size} mensagem(ns)`,
            inline: true,
          },
          {
            name: "👮 Deletadas por",
            value: deletedBy,
            inline: true,
          },
          {
            name: "📝 Mensagens",
            value: truncateText(messageList || "*Nenhum conteúdo disponível*"),
            inline: false,
          },
          {
            name: "🕐 Horário",
            value: formatTimestamp(),
            inline: false,
          }
        )
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
    const channelMention = `<#${newMessage.channel.id}>`;

    const embed = new EmbedBuilder()
      .setColor(0x3498db) // Azul
      .setTitle("✏️ Mensagem Editada")
      .addFields(
        {
          name: "👤 Autor",
          value: author ? `<@${author.id}> (${author.tag})` : "*Desconhecido*",
          inline: true,
        },
        {
          name: "📌 Canal",
          value: channelMention,
          inline: true,
        },
        {
          name: "🔗 Ir para mensagem",
          value: `[Clique aqui](${newMessage.url})`,
          inline: true,
        },
        {
          name: "📝 Antes",
          value: truncateText(oldContent || "*[Conteúdo não disponível no cache]*"),
          inline: false,
        },
        {
          name: "📝 Depois",
          value: truncateText(newContent || "*[Sem conteúdo]*"),
          inline: false,
        },
        {
          name: "🕐 Horário da edição",
          value: formatTimestamp(),
          inline: false,
        }
      )
      .setFooter({
        text: `ID da mensagem: ${newMessage.id} | ID do autor: ${author?.id || "N/A"}`,
      })
      .setTimestamp();

    if (author) {
      embed.setAuthor({
        name: author.tag,
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
