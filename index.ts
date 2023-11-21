import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputApplicationCommandData,
  Client,
  CommandInteraction,
  ComponentType,
  Events,
  GatewayIntentBits,
} from "discord.js";
import k8s from "@kubernetes/client-node";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";

dayjs.extend(duration);

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

interface Command extends ChatInputApplicationCommandData {
  run: (interaction: CommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const timeouts = new Map<{ discordId: string }, NodeJS.Timeout>();

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
    await interaction.deferReply({ ephemeral: true });
    await sleep(1000 * 5);

    const identifier = `${interaction.user.globalName}-${interaction.user.id}`;
    const podName = `workspace-${identifier}`;

    const pods = await k8sApi.listNamespacedPod({ namespace: "workspaces" });
    if (pods.items.find((pod) => pod.metadata?.name === podName)) {
      await interaction.editReply({
        content: `Workspace already exists! Visit it at `,
      });
      return;
    }

    let pod = await k8sApi.createNamespacedPod({
      namespace: "workspaces",
      body: {
        metadata: {
          name: podName,
          annotations: {
            "io.kubernetes.cri-o.userns-mode": "auto:size=65536",
          },
        },
        spec: {
          runtimeClassName: "sysbox-runc",
          hostname: "cscosu",
          containers: [
            {
              name: "workspace",
              image: "ghcr.io/cscosu/vs-workspace:latest",
              imagePullPolicy: "Always",
              resources: {
                limits: {
                  cpu: "500m",
                  memory: "768Mi",
                },
                requests: {
                  cpu: "10m",
                  memory: "128Mi",
                },
              },
            },
          ],
        },
      },
    });

    do {
      pod = await k8sApi.readNamespacedPod({
        name: podName,
        namespace: "workspaces",
      });
      sleep(1000);
    } while (pod.status?.phase !== "Running");

    const extendSessionButton = new ButtonBuilder()
      .setCustomId("extend-session")
      .setLabel("Extend Session")
      .setStyle(ButtonStyle.Primary);

    const deleteTimestamp = Math.floor(Date.now() / 1000) + 9;

    setTimeout(async () => {
      const message = await interaction.user.send({
        content: `Your workspace will be deleted <t:${deleteTimestamp}:R>`,
        components: [
          {
            type: ComponentType.ActionRow,
            components: [extendSessionButton],
          },
        ],
      });

      const deleteTimeoutFn = () =>
        setTimeout(async () => {
          const pod = await k8sApi.readNamespacedPod({
            name: podName,
            namespace: "workspaces",
          });

          const age = dayjs.duration(dayjs().diff(pod.status!.startTime!));

          await message.edit({
            content: `Your workspace lasted \`${age.format("HH:mm")}\``,
          });

          await k8sApi.deleteNamespacedPod({
            name: podName,
            namespace: "workspaces",
          });
        }, 1000 * 5);

      const extendFn = async () => {
        await message.edit({
          content: `Extending the workspace until`,
        });
      };

      const deleteTimeout = deleteTimeoutFn();
    }, 1000 * 5);

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
