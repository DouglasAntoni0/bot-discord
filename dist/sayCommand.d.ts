import { Client, Guild } from "discord.js";
/**
 * Comando /falar: faz o bot enviar uma mensagem em nome dele mesmo.
 * - Apenas administradores podem usar (escondido para os demais e verificado em runtime).
 * - A resposta ao admin é efêmera, então ninguém vê quem enviou.
 * - Permite mencionar @everyone, @here, um cargo e/ou um usuário.
 */
export declare const SAY_COMMAND_NAME = "falar";
/** Cria/atualiza o comando /falar no servidor (registro por servidor é instantâneo). */
export declare function registerSayCommand(guild: Guild): Promise<void>;
/** Liga os listeners do comando /falar no client. */
export declare function setupSayCommand(client: Client): void;
//# sourceMappingURL=sayCommand.d.ts.map