"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAY_COMMAND_NAME = void 0;
exports.registerSayCommand = registerSayCommand;
exports.setupSayCommand = setupSayCommand;
const discord_js_1 = require("discord.js");
/**
 * Comando /falar: faz o bot enviar uma mensagem em nome dele mesmo.
 * - Apenas administradores podem usar (escondido para os demais e verificado em runtime).
 * - A resposta ao admin é efêmera, então ninguém vê quem enviou.
 * - Permite mencionar @everyone, @here, um cargo e/ou um usuário.
 * - Estilo "caixinha" usa os Components V2 do Discord (container com título, divisórias e rodapé).
 */
exports.SAY_COMMAND_NAME = "falar";
const MODAL_PREFIX = `${exports.SAY_COMMAND_NAME}:`;
const MODAL_MESSAGE_INPUT_ID = "mensagem";
const MODAL_TITLE_INPUT_ID = "titulo";
const TEXT_MESSAGE_MAX_LENGTH = 2000;
const BOX_MESSAGE_MAX_LENGTH = 4000;
const TITLE_MAX_LENGTH = 256;
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
];
const ALLOWED_CHANNEL_TYPES = [
    discord_js_1.ChannelType.GuildText,
    discord_js_1.ChannelType.GuildAnnouncement,
    discord_js_1.ChannelType.GuildVoice,
    discord_js_1.ChannelType.GuildStageVoice,
    discord_js_1.ChannelType.PublicThread,
    discord_js_1.ChannelType.PrivateThread,
    discord_js_1.ChannelType.AnnouncementThread,
];
const sayCommand = new discord_js_1.SlashCommandBuilder()
    .setName(exports.SAY_COMMAND_NAME)
    .setDescription("Faz o bot enviar uma mensagem como se fosse ele (somente administradores)")
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
    .setName("mensagem")
    .setDescription("Texto da mensagem. Use \\n para quebrar linha. Deixe vazio para abrir um editor")
    .setMaxLength(BOX_MESSAGE_MAX_LENGTH))
    .addStringOption((option) => option
    .setName("estilo")
    .setDescription("Formato da mensagem (padrão: caixinha)")
    .addChoices({ name: "Caixinha", value: "box" }, { name: "Texto normal", value: "txt" }))
    .addStringOption((option) => option
    .setName("titulo")
    .setDescription("Título grande no topo da mensagem (ex.: 📄 Changelog - 02.10)")
    .setMaxLength(TITLE_MAX_LENGTH))
    .addStringOption((option) => option
    .setName("mencao")
    .setDescription("Menção especial (@everyone / @here)")
    .addChoices({ name: "Nenhuma", value: "none" }, { name: "@everyone", value: "everyone" }, { name: "@here", value: "here" }))
    .addRoleOption((option) => option.setName("cargo").setDescription("Cargo para mencionar"))
    .addUserOption((option) => option.setName("usuario").setDescription("Usuário para mencionar"))
    .addStringOption((option) => option
    .setName("cor")
    .setDescription("Cor da faixa lateral da caixinha (padrão: sem cor)")
    .addChoices(...COLOR_CHOICES))
    .addChannelOption((option) => option
    .setName("canal")
    .setDescription("Canal onde a mensagem será enviada (padrão: canal atual)")
    .addChannelTypes(...ALLOWED_CHANNEL_TYPES));
function isAdmin(interaction) {
    return interaction.memberPermissions?.has(discord_js_1.PermissionFlagsBits.Administrator) ?? false;
}
function parseMention(value) {
    return value === "everyone" || value === "here" ? value : "none";
}
function parseStyle(value) {
    return value === "txt" ? "txt" : "box";
}
function parseColor(value) {
    if (!value || value === "none" || value === "-")
        return null;
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) ? parsed : null;
}
function encodeModalId(options) {
    return [
        exports.SAY_COMMAND_NAME,
        options.channelId,
        options.mention,
        options.roleId ?? "-",
        options.userId ?? "-",
        options.style,
        options.color === null ? "-" : options.color.toString(16),
    ].join(":");
}
function decodeModalId(customId) {
    const [name, channelId, mention, roleId, userId, style, color] = customId.split(":");
    if (name !== exports.SAY_COMMAND_NAME || !channelId)
        return null;
    return {
        channelId,
        mention: parseMention(mention),
        roleId: roleId && roleId !== "-" ? roleId : null,
        userId: userId && userId !== "-" ? userId : null,
        style: parseStyle(style),
        color: parseColor(color),
    };
}
function buildMentionText(options) {
    const mentions = [];
    if (options.mention === "everyone")
        mentions.push("@everyone");
    if (options.mention === "here")
        mentions.push("@here");
    if (options.roleId)
        mentions.push(`<@&${options.roleId}>`);
    if (options.userId)
        mentions.push(`<@${options.userId}>`);
    return mentions.join(" ");
}
function formatTitle(title) {
    return title.startsWith("#") ? title : `# ${title}`;
}
function buildTextPayload(options, title, body) {
    const parts = [buildMentionText(options), title ? formatTitle(title) : "", body].filter(Boolean);
    const content = parts.join("\n");
    if (!content)
        return { error: "❌ A mensagem está vazia. Escreva algo ou escolha uma menção." };
    if (content.length > TEXT_MESSAGE_MAX_LENGTH) {
        return {
            error: `❌ A mensagem ficou com ${content.length} caracteres (máximo ${TEXT_MESSAGE_MAX_LENGTH} no estilo texto normal). Use o estilo caixinha para até ${BOX_MESSAGE_MAX_LENGTH}.`,
        };
    }
    return { payload: { content } };
}
function buildBoxPayload(options, title, body) {
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
    const container = new discord_js_1.ContainerBuilder();
    if (options.color !== null)
        container.setAccentColor(options.color);
    sections.forEach((section, index) => {
        if (index > 0) {
            container.addSeparatorComponents((separator) => separator.setDivider(true).setSpacing(discord_js_1.SeparatorSpacingSize.Large));
        }
        container.addTextDisplayComponents((text) => text.setContent(section));
    });
    return {
        payload: {
            components: [container],
            flags: discord_js_1.MessageFlags.IsComponentsV2,
        },
    };
}
async function resolveTargetChannel(guild, channelId) {
    try {
        const channel = guild.channels.cache.get(channelId) ??
            (await guild.client.channels.fetch(channelId).catch(() => null));
        if (!channel || !channel.isTextBased() || channel.isDMBased())
            return null;
        if (channel.guildId !== guild.id)
            return null;
        return channel;
    }
    catch {
        return null;
    }
}
/** Valida permissões e envia. Retorna mensagem de sucesso/erro para o admin. */
async function sendAsBot(guild, options, rawTitle, rawBody, requestedBy) {
    const channel = await resolveTargetChannel(guild, options.channelId);
    if (!channel) {
        return "❌ Não consegui encontrar esse canal ou ele não aceita mensagens de texto.";
    }
    const title = rawTitle.trim();
    const body = rawBody.trim();
    const built = options.style === "box"
        ? buildBoxPayload(options, title, body)
        : buildTextPayload(options, title, body);
    if ("error" in built)
        return built.error;
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const permissions = me ? channel.permissionsFor(me) : null;
    const sendFlag = channel.isThread()
        ? discord_js_1.PermissionFlagsBits.SendMessagesInThreads
        : discord_js_1.PermissionFlagsBits.SendMessages;
    if (!permissions?.has([discord_js_1.PermissionFlagsBits.ViewChannel, sendFlag])) {
        return `❌ Não tenho permissão para ver/enviar mensagens em <#${channel.id}>.`;
    }
    const canMentionEveryone = permissions.has(discord_js_1.PermissionFlagsBits.MentionEveryone);
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
    const parse = ["users", "roles"];
    if (options.mention !== "none")
        parse.push("everyone");
    try {
        await channel.send({ ...built.payload, allowedMentions: { parse } });
    }
    catch (error) {
        console.error("[FALAR] Falha ao enviar mensagem:", error);
        return "❌ O Discord recusou o envio da mensagem. Verifique minhas permissões no canal.";
    }
    console.log(`[FALAR] ${requestedBy} enviou uma mensagem pelo bot em #${channel.name} (${channel.id}).`);
    return `✅ Mensagem enviada em <#${channel.id}>.`;
}
async function handleChatInput(interaction) {
    if (!interaction.inCachedGuild()) {
        await interaction.reply({
            content: "❌ Esse comando só pode ser usado dentro de um servidor.",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
        return;
    }
    if (!isAdmin(interaction)) {
        await interaction.reply({
            content: "❌ Apenas administradores podem usar esse comando.",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
        return;
    }
    const options = {
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
        const hasOtherContent = options.mention !== "none" || Boolean(options.roleId) || Boolean(options.userId) || Boolean(title);
        const titleInput = new discord_js_1.TextInputBuilder()
            .setCustomId(MODAL_TITLE_INPUT_ID)
            .setLabel("Título (opcional)")
            .setStyle(discord_js_1.TextInputStyle.Short)
            .setPlaceholder("Ex.: 📄 Changelog - 02.10")
            .setRequired(false)
            .setMaxLength(TITLE_MAX_LENGTH);
        if (title)
            titleInput.setValue(title);
        const messageInput = new discord_js_1.TextInputBuilder()
            .setCustomId(MODAL_MESSAGE_INPUT_ID)
            .setLabel("Mensagem")
            .setStyle(discord_js_1.TextInputStyle.Paragraph)
            .setPlaceholder("### 🔄 Atualizado\n- Item da lista\n**negrito**, *itálico*, `código`...")
            .setRequired(!hasOtherContent)
            .setMaxLength(options.style === "box" ? BOX_MESSAGE_MAX_LENGTH : TEXT_MESSAGE_MAX_LENGTH);
        const modal = new discord_js_1.ModalBuilder()
            .setCustomId(encodeModalId(options))
            .setTitle(options.style === "box" ? "Enviar caixinha como o bot" : "Enviar mensagem como o bot")
            .addComponents(new discord_js_1.ActionRowBuilder().addComponents(titleInput), new discord_js_1.ActionRowBuilder().addComponents(messageInput));
        await interaction.showModal(modal);
        return;
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const text = rawText.replace(/\\n/g, "\n");
    const result = await sendAsBot(interaction.guild, options, title, text, interaction.user.tag);
    await interaction.editReply({ content: result });
}
async function handleModalSubmit(interaction) {
    const options = decodeModalId(interaction.customId);
    if (!options)
        return;
    if (!interaction.inCachedGuild() || !isAdmin(interaction)) {
        await interaction.reply({
            content: "❌ Apenas administradores podem usar esse comando.",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
        return;
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const title = interaction.fields.getTextInputValue(MODAL_TITLE_INPUT_ID) ?? "";
    const text = interaction.fields.getTextInputValue(MODAL_MESSAGE_INPUT_ID) ?? "";
    const result = await sendAsBot(interaction.guild, options, title, text, interaction.user.tag);
    await interaction.editReply({ content: result });
}
/** Cria/atualiza o comando /falar no servidor (registro por servidor é instantâneo). */
async function registerSayCommand(guild) {
    try {
        await guild.commands.create(sayCommand.toJSON());
        console.log(`  💬 [${guild.name}] Comando /${exports.SAY_COMMAND_NAME} registrado.`);
    }
    catch (error) {
        console.error(`[FALAR] Não consegui registrar /${exports.SAY_COMMAND_NAME} em ${guild.name}:`, error);
    }
}
/** Liga os listeners do comando /falar no client. */
function setupSayCommand(client) {
    client.on(discord_js_1.Events.GuildCreate, (guild) => {
        void registerSayCommand(guild);
    });
    client.on(discord_js_1.Events.InteractionCreate, async (interaction) => {
        try {
            if (interaction.isChatInputCommand() && interaction.commandName === exports.SAY_COMMAND_NAME) {
                await handleChatInput(interaction);
            }
            else if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
                await handleModalSubmit(interaction);
            }
        }
        catch (error) {
            console.error("[FALAR] Erro ao processar interação:", error);
            if (interaction.isRepliable()) {
                const payload = { content: "❌ Ocorreu um erro ao enviar a mensagem." };
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(payload).catch(() => undefined);
                }
                else {
                    await interaction
                        .reply({ ...payload, flags: discord_js_1.MessageFlags.Ephemeral })
                        .catch(() => undefined);
                }
            }
        }
    });
}
//# sourceMappingURL=sayCommand.js.map