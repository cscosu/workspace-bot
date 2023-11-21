import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
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
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(duration);
dayjs.extend(relativeTime);

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

const timeouts = new Map<
  string,
  {
    timeout: NodeJS.Timeout;
    end: {
      id: "end-session";
      fn: () => Promise<void>;
    };
    extend: {
      id: "extend-session";
      fn: () => Promise<void>;
    };
  }
>();

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
        content: `Workspace already exists!`,
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                url: "http://localhost:9001",
                label: "Open workspace",
              },
            ],
          },
        ],
      });
      return;
    }

    const password = "password";

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

    const workspaceDuration = 1000 * 60 * 60;

    const warnFn = (deleteTimestamp: Date) => {
      const warningOffset = 1000 * 60 * 10;

      setTimeout(async () => {
        const message = await interaction.user.send({
          content: `Your workspace will be deleted <t:${Math.floor(
            deleteTimestamp.getTime() / 1000
          )}:R>. If you're still using it, you can add more time by clicking the button below.`,
          components: [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Primary,
                  customId: "extend-session",
                  label: "Add another hour",
                },
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Danger,
                  customId: "end-session",
                  label: "End session",
                },
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Link,
                  url: "http://localhost:9001",
                  label: "Open workspace",
                },
              ],
            },
          ],
        });

        const deleteTimeoutFn = () =>
          setTimeout(async () => endFn(), warningOffset);

        const endFn = async () => {
          const t = timeouts.get(interaction.user.id);
          clearTimeout(t?.timeout);

          const pod = await k8sApi.readNamespacedPod({
            name: podName,
            namespace: "workspaces",
          });

          const age = dayjs.duration(dayjs().diff(pod.status!.startTime!));

          await message.edit({
            content: `Your workspace lasted ${age.humanize()}`,
            components: [],
          });

          await k8sApi.deleteNamespacedPod({
            name: podName,
            namespace: "workspaces",
          });
        };

        const extendFn = async () => {
          const newDeleteTimestamp = new Date(
            deleteTimestamp.getTime() + workspaceDuration
          );

          await message.edit({
            content: `Extending the workspace until <t:${Math.floor(
              newDeleteTimestamp.getTime() / 1000
            )}:t>`,
            components: [
              {
                type: ComponentType.ActionRow,
                components: [
                  {
                    type: ComponentType.Button,
                    style: ButtonStyle.Link,
                    url: "http://localhost:9001",
                    label: "Open workspace",
                  },
                ],
              },
            ],
          });

          const t = timeouts.get(interaction.user.id);
          clearTimeout(t?.timeout);
          warnFn(newDeleteTimestamp);
        };

        const deleteTimeout = deleteTimeoutFn();
        timeouts.set(interaction.user.id, {
          timeout: deleteTimeout,
          end: { fn: endFn, id: "end-session" },
          extend: { fn: extendFn, id: "extend-session" },
        });
      }, deleteTimestamp.getTime() - new Date().getTime() - warningOffset);
    };

    const endTime = new Date(new Date().getTime() + workspaceDuration);
    warnFn(endTime);

    await interaction.editReply({
      content: `Workspace created! It will expire at <t:${Math.floor(
        endTime.getTime() / 1000
      )}:t>. Log in using the password ||${password}||`,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              url: "http://localhost:9001",
              label: "Open workspace",
            },
          ],
        },
      ],
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
  if (interaction.isButton()) {
    const t = timeouts.get(interaction.user.id);

    if (interaction.customId === t?.end.id) await t.end.fn();
    if (interaction.customId === t?.extend.id) await t.extend.fn();
    interaction.update({});
  }
});

client.login(Bun.env.DISCORD_BOT_TOKEN);
