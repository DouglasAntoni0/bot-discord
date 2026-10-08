import {
  ActionRowBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  ContainerBuilder,
  Events,
  Guild,
  GuildTextBasedChannel,
  MessageCreateOptions,
  MessageFlags,
  MessageMentionTypes,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

/**
 * Comando /falar: faz o bot enviar uma mensagem em nome dele mesmo.
 * - Apenas administradores podem usar (escondido para os demais e verificado em runtime).
 * - A resposta ao admin é efêmera, então ninguém vê quem enviou.
 * - Permite mencionar @everyone, @here, um cargo e/ou um usuário.
 * - Estilo "caixinha" usa os Components V2 do Discord (container com título, divisórias e rodapé).
 */

export const SAY_COMMAND_NAME = "falar";
const MODAL_PREFIX = `${SAY_COMMAND_NAME}:`;
const MODAL_MESSAGE_INPUT_ID = "mensagem";
const MODAL_TITLE_INPUT_ID = "titulo";
const TEXT_MESSAGE_MAX_LENGTH = 2000;
const BOX_MESSAGE_MAX_LENGTH = 4000;
const TITLE_MAX_LENGTH = 256;

type SpecialMention = "none" | "everyone" | "here";
type SayStyle = "box" | "txt";

interface SayOptions {
  channelId: string;
  mention: SpecialMention;
  roleId: string | null;
  userId: string | null;
  style: SayStyle;
  color: number | null;
}

const COLOR_CHOICES = [
  { name: "Sem cor", value: "none" },
  { name: "Roxo", value: "9b59b6" },
  { name: "Azul", value: "3498db" },
  { name: "Verde", value: "2ecc71" },
  { name: "Amarelo", value: "f1c40f" },
  { name: "Laranja", value: "e67e22" },
  { name: "Vermelho", value: "e74c3c" },
  { name: "Rosa", value: "e91e63" },
  { name: "Branco", value: "ffffff" },
] as const;

const ALLOWED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
] as const;

const sayCommand = new SlashCommandBuilder()
  .setName(SAY_COMMAND_NAME)
  .setDescription("Faz o bot enviar uma mensagem como se fosse ele (somente administradores)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("mensagem")
      .setDescription("Texto da mensagem. Use \\n para quebrar linha. Deixe vazio para abrir um editor")
      .setMaxLength(BOX_MESSAGE_MAX_LENGTH)
  )
  .addStringOption((option) =>
    option
      .setName("estilo")
      .setDescription("Formato da mensagem (padrão: caixinha)")
      .addChoices(
        { name: "Caixinha", value: "box" },
        { name: "Texto normal", value: "txt" }
      )
  )
  .addStringOption((option) =>
    option
      .setName("titulo")
      .setDescription("Título grande no topo da mensagem (ex.: 📄 Changelog - 02.10)")
      .setMaxLength(TITLE_MAX_LENGTH)
  )
  .addStringOption((option) =>
    option
      .setName("mencao")
      .setDescription("Menção especial (@everyone / @here)")
      .addChoices(
        { name: "Nenhuma", value: "none" },
        { name: "@everyone", value: "everyone" },
        { name: "@here", value: "here" }
      )
  )
  .addRoleOption((option) =>
    option.setName("cargo").setDescription("Cargo para mencionar")
  )
  .addUserOption((option) =>
    option.setName("usuario").setDescription("Usuário para mencionar")
  )
  .addStringOption((option) =>
    option
      .setName("cor")
      .setDescription("Cor da faixa lateral da caixinha (padrão: sem cor)")
      .addChoices(...COLOR_CHOICES)
  )
  .addChannelOption((option) =>
    option
      .setName("canal")
      .setDescription("Canal onde a mensagem será enviada (padrão: canal atual)")
      .addChannelTypes(...ALLOWED_CHANNEL_TYPES)
  );

function isAdmin(interaction: ChatInputCommandInteraction | ModalSubmitInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

function parseMention(value: string | null | undefined): SpecialMention {
  return value === "everyone" || value === "here" ? value : "none";
}

function parseStyle(value: string | null | undefined): SayStyle {
  return value === "txt" ? "txt" : "box";
}

function parseColor(value: string | null | undefined): number | null {
  if (!value || value === "none" || value === "-") return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

function encodeModalId(options: SayOptions): string {
  return [
    SAY_COMMAND_NAME,
    options.channelId,
    options.mention,
    options.roleId ?? "-",
    options.userId ?? "-",
    options.style,
    options.color === null ? "-" : options.color.toString(16),
  ].join(":");
}

function decodeModalId(customId: string): SayOptions | null {
  const [name, channelId, mention, roleId, userId, style, color] = customId.split(":");
  if (name !== SAY_COMMAND_NAME || !channelId) return null;

  return {
    channelId,
    mention: parseMention(mention),
    roleId: roleId && roleId !== "-" ? roleId : null,
    userId: userId && userId !== "-" ? userId : null,
    style: parseStyle(style),
    color: parseColor(color),
  };
}

function buildMentionText(options: SayOptions): string {
  const mentions: string[] = [];
  if (options.mention === "everyone") mentions.push("@everyone");
  if (options.mention === "here") mentions.push("@here");
  if (options.roleId) mentions.push(`<@&${options.roleId}>`);
  if (options.userId) mentions.push(`<@${options.userId}>`);
  return mentions.join(" ");
}

function formatTitle(title: string): string {
  return title.startsWith("#") ? title : `# ${title}`;
}

type BuildResult = { payload: MessageCreateOptions } | { error: string };

function buildTextPayload(options: SayOptions, title: string, body: string): BuildResult {
  const parts = [buildMentionText(options), title ? formatTitle(title) : "", body].filter(Boolean);
  const content = parts.join("\n");

  if (!content) return { error: "❌ A mensagem está vazia. Escreva algo ou escolha uma menção." };
  if (content.length > TEXT_MESSAGE_MAX_LENGTH) {
    return {
      error: `❌ A mensagem ficou com ${content.length} caracteres (máximo ${TEXT_MESSAGE_MAX_LENGTH} no estilo texto normal). Use o estilo caixinha para até ${BOX_MESSAGE_MAX_LENGTH}.`,
    };
  }

  return { payload: { content } };
}

function buildBoxPayload(options: SayOptions, title: string, body: string): BuildResult {
  const mentionText = buildMentionText(options);
  const sections = [
    title ? formatTitle(title) : "",
    body,
    mentionText ? `-# ${mentionText}` : "",
  ].filter(Boolean);

  if (sections.length === 0) {
    return { error: "❌ A mensagem está vazia. Escreva algo, um título ou escolha uma menção." };
  }

  const totalLength = sections.reduce((sum, section) => sum + section.length, 0);
  if (totalLength > BOX_MESSAGE_MAX_LENGTH) {
    return {
      error: `❌ A caixinha ficou com ${totalLength} caracteres (máximo ${BOX_MESSAGE_MAX_LENGTH}, somando título, texto e menções).`,
    };
  }

  const container = new ContainerBuilder();
  if (options.color !== null) container.setAccentColor(options.color);

  sections.forEach((section, index) => {
    if (index > 0) {
      container.addSeparatorComponents((separator) =>
        separator.setDivider(true).setSpacing(SeparatorSpacingSize.Large)
      );
    }
    container.addTextDisplayComponents((text) => text.setContent(section));
  });

  return {
    payload: {
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    },
  };
}

async function resolveTargetChannel(
  guild: Guild,
  channelId: string
): Promise<GuildTextBasedChannel | null> {
  try {
    const channel =
      guild.channels.cache.get(channelId) ??
      (await guild.client.channels.fetch(channelId).catch(() => null));

    if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
    if (channel.guildId !== guild.id) return null;
    return channel as GuildTextBasedChannel;
  } catch {
    return null;
  }
}

/** Valida permissões e envia. Retorna mensagem de sucesso/erro para o admin. */
async function sendAsBot(
  guild: Guild,
  options: SayOptions,
  rawTitle: string,
  rawBody: string,
  requestedBy: string
): Promise<string> {
  const channel = await resolveTargetChannel(guild, options.channelId);
  if (!channel) {
    return "❌ Não consegui encontrar esse canal ou ele não aceita mensagens de texto.";
  }

  const title = rawTitle.trim();
  const body = rawBody.trim();
  const built =
    options.style === "box"
      ? buildBoxPayload(options, title, body)
      : buildTextPayload(options, title, body);
  if ("error" in built) return built.error;

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const permissions = me ? channel.permissionsFor(me) : null;
  const sendFlag = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;

  if (!permissions?.has([PermissionFlagsBits.ViewChannel, sendFlag])) {
    return `❌ Não tenho permissão para ver/enviar mensagens em <#${channel.id}>.`;
  }

  const canMentionEveryone = permissions.has(PermissionFlagsBits.MentionEveryone);

  if (options.mention !== "none" && !canMentionEveryone) {
    return `❌ Não tenho a permissão **Mencionar @everyone, @here e todos os cargos** em <#${channel.id}>, então a menção não iria notificar ninguém.`;
  }

  if (options.roleId && !canMentionEveryone) {
    const role = guild.roles.cache.get(options.roleId);
    if (role && !role.mentionable) {
      return `❌ O cargo <@&${options.roleId}> não é mencionável e eu não tenho a permissão **Mencionar @everyone, @here e todos os cargos**.`;
    }
  }

  // @everyone/@here só notificam quando escolhidos na opção "mencao".
  const parse: MessageMentionTypes[] = ["users", "roles"];
  if (options.mention !== "none") parse.push("everyone");

  try {
    await channel.send({ ...built.payload, allowedMentions: { parse } });
  } catch (error) {
    console.error("[FALAR] Falha ao enviar mensagem:", error);
    return "❌ O Discord recusou o envio da mensagem. Verifique minhas permissões no canal.";
  }

  console.log(`[FALAR] ${requestedBy} enviou uma mensagem pelo bot em #${channel.name} (${channel.id}).`);
  return `✅ Mensagem enviada em <#${channel.id}>.`;
}

async function handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "❌ Esse comando só pode ser usado dentro de um servidor.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: "❌ Apenas administradores podem usar esse comando.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const options: SayOptions = {
    channelId: interaction.options.getChannel("canal")?.id ?? interaction.channelId,
    mention: parseMention(interaction.options.getString("mencao")),
    roleId: interaction.options.getRole("cargo")?.id ?? null,
    userId: interaction.options.getUser("usuario")?.id ?? null,
    style: parseStyle(interaction.options.getString("estilo")),
    color: parseColor(interaction.options.getString("cor")),
  };

  const title = interaction.options.getString("titulo") ?? "";
  const rawText = interaction.options.getString("mensagem");

  // Sem texto: abre um editor (modal) com suporte a várias linhas.
  if (rawText === null) {
    const hasOtherContent =
      options.mention !== "none" || Boolean(options.roleId) || Boolean(options.userId) || Boolean(title);

    const titleInput = new TextInputBuilder()
      .setCustomId(MODAL_TITLE_INPUT_ID)
      .setLabel("Título (opcional)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Ex.: 📄 Changelog - 02.10")
      .setRequired(false)
      .setMaxLength(TITLE_MAX_LENGTH);
    if (title) titleInput.setValue(title);

    const messageInput = new TextInputBuilder()
      .setCustomId(MODAL_MESSAGE_INPUT_ID)
      .setLabel("Mensagem")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("### 🔄 Atualizado\n- Item da lista\n**negrito**, *itálico*, `código`...")
      .setRequired(!hasOtherContent)
      .setMaxLength(options.style === "box" ? BOX_MESSAGE_MAX_LENGTH : TEXT_MESSAGE_MAX_LENGTH);

    const modal = new ModalBuilder()
      .setCustomId(encodeModalId(options))
      .setTitle(options.style === "box" ? "Enviar caixinha como o bot" : "Enviar mensagem como o bot")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput)
      );

    await interaction.showModal(modal);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = rawText.replace(/\\n/g, "\n");
  const result = await sendAsBot(interaction.guild, options, title, text, interaction.user.tag);
  await interaction.editReply({ content: result });
}

async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const options = decodeModalId(interaction.customId);
  if (!options) return;

  if (!interaction.inCachedGuild() || !isAdmin(interaction)) {
    await interaction.reply({
      content: "❌ Apenas administradores podem usar esse comando.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const title = interaction.fields.getTextInputValue(MODAL_TITLE_INPUT_ID) ?? "";
  const text = interaction.fields.getTextInputValue(MODAL_MESSAGE_INPUT_ID) ?? "";
  const result = await sendAsBot(interaction.guild, options, title, text, interaction.user.tag);
  await interaction.editReply({ content: result });
}

/** Cria/atualiza o comando /falar no servidor (registro por servidor é instantâneo). */
export async function registerSayCommand(guild: Guild): Promise<void> {
  try {
    await guild.commands.create(sayCommand.toJSON());
    console.log(`  💬 [${guild.name}] Comando /${SAY_COMMAND_NAME} registrado.`);
  } catch (error) {
    console.error(`[FALAR] Não consegui registrar /${SAY_COMMAND_NAME} em ${guild.name}:`, error);
  }
}

/** Liga os listeners do comando /falar no client. */
export function setupSayCommand(client: Client): void {
  client.on(Events.GuildCreate, (guild) => {
    void registerSayCommand(guild);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === SAY_COMMAND_NAME) {
        await handleChatInput(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
        await handleModalSubmit(interaction);
      }
    } catch (error) {
      console.error("[FALAR] Erro ao processar interação:", error);

      if (interaction.isRepliable()) {
        const payload = { content: "❌ Ocorreu um erro ao enviar a mensagem." };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(payload).catch(() => undefined);
        } else {
          await interaction
            .reply({ ...payload, flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
    }
  });
}
