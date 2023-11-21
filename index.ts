import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputApplicationCommandData,
  Client,
  CommandInteraction,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

interface Command extends ChatInputApplicationCommandData {
  run: (interaction: CommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const createWorkspace: Command = {
  name: "workspace",
  description: "Linux workspace management",
  options: [
    {
      name: "create",
      type: ApplicationCommandOptionType.Subcommand,
      description: "Create a new linux workspace",
    },
  ],
  async run(interaction) {
    await interaction.deferReply();
    await sleep(1000 * 5);

    await interaction.editReply({
      content: `Workspace created! Visit it at `,
    });
  },
};

const commands = [createWorkspace];

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands);

  console.log(`${c.user.tag} is ready!`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commands.find((c) => c.name === interaction.commandName);
    if (command && command.autocomplete)
      await command.autocomplete(interaction);
  }
  if (interaction.isCommand()) {
    const command = commands.find((c) => c.name === interaction.commandName);
    if (command) await command.run(interaction);
  }
});

client.login(Bun.env.DISCORD_BOT_TOKEN);
