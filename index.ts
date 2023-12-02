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
  GuildMemberRoleManager,
} from "discord.js";
import * as k8s from "@kubernetes/client-node";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import relativeTime from "dayjs/plugin/relativeTime";
import { randomBytes } from "node:crypto";
import { config } from "dotenv";

config();

dayjs.extend(duration);
dayjs.extend(relativeTime);

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sCore = kc.makeApiClient(k8s.CoreV1Api);
const k8sNetworking = kc.makeApiClient(k8s.NetworkingV1Api);

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

    const id = `workspace-${interaction.user.id}`;

    const pods = await k8sCore.listNamespacedPod({ namespace: "workspaces" });
    const existingPod = pods.items.find((pod) => pod.metadata?.name === id);
    if (existingPod) {
      const password = existingPod.metadata?.labels?.["password"];
      await interaction.editReply({
        content: `Workspace already exists! Access it with the button below.`,
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                url: `https://workspace.osucyber.club/${interaction.user.id}/login?password=${password}`,
                label: "Open workspace",
              },
            ],
          },
        ],
      });
      return;
    }

    const password = randomBytes(4).toString("hex");

    await k8sCore.createNamespacedService({
      namespace: "workspaces",
      body: {
        metadata: {
          name: id,
          labels: {
            app: id,
          },
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: id,
          },
          ports: [
            {
              name: "http",
              protocol: "TCP",
              port: 8080,
              targetPort: 8080,
            },
          ],
        },
      },
    });

    await k8sNetworking.createNamespacedIngress({
      namespace: "workspaces",
      body: {
        metadata: {
          name: id,
          annotations: {
            "cert-manager.io/cluster-issuer": "letsencrypt-prod",
            "nginx.ingress.kubernetes.io/rewrite-target": "/$1",
          },
        },
        spec: {
          ingressClassName: "public",
          rules: [
            {
              host: "workspace.osucyber.club",
              http: {
                paths: [
                  {
                    path: `/${interaction.user.id}/(.*)`,
                    pathType: "Prefix",
                    backend: {
                      service: {
                        name: id,
                        port: {
                          name: "http",
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
          tls: [
            {
              hosts: ["workspace.osucyber.club"],
              secretName: "workspace-tls-certificate",
            },
          ],
        },
      },
    });

    await k8sCore.createNamespacedConfigMap({
      namespace: "workspaces",
      body: {
        metadata: {
          name: id,
        },
        data: {
          "config.yaml": `bind-addr: 127.0.0.1:8080
auth: password
password: ${password}
cert: false
`,
        },
      },
    });

    let pod = await k8sCore.createNamespacedPod({
      namespace: "workspaces",
      body: {
        metadata: {
          name: id,
          labels: {
            app: id,
            workspace: "true",
            password,
            discordId: interaction.user.id,
            discordUsername: interaction.user.username,
          },
          annotations: {
            "io.kubernetes.cri-o.userns-mode": "auto:size=65536",
          },
        },
        spec: {
          runtimeClassName: "sysbox-runc",
          hostname: "cscosu",
          dnsPolicy: "None",
          dnsConfig: {
            nameservers: ["1.1.1.1"],
          },
          containers: [
            {
              name: "workspace",
              image: "ghcr.io/cscosu/vs-workspace:latest",
              imagePullPolicy: "Always",
              volumeMounts: [
                {
                  name: "code-server-config",
                  mountPath: "/home/coder/.config/code-server/config.yaml",
                  subPath: "config.yaml",
                },
              ],
              resources: {
                limits: {
                  cpu: "500m",
                  memory: "2048Mi",
                },
                requests: {
                  cpu: "10m",
                  memory: "128Mi",
                },
              },
            },
          ],
          volumes: [
            {
              name: "code-server-config",
              configMap: {
                name: id,
              },
            },
          ],
        },
      },
    });

    const botChannel = await interaction.guild?.channels.fetch(
      "797000475266383883"
    );
    if (!botChannel?.isTextBased())
      throw new Error("Bot channel is not a text channel");

    do {
      pod = await k8sCore.readNamespacedPod({
        name: id,
        namespace: "workspaces",
      });
      sleep(1000);
    } while (pod.status?.phase !== "Running");

    const workspaceDuration = 1000 * 60 * 60 * 24;

    const warnFn = (deleteTimestamp: Date) => {
      const warningOffset = 1000 * 60 * 60 * 1;

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
                  url: `https://workspace.osucyber.club/${interaction.user.id}/login?password=${password}`,
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

          const pod = await k8sCore.readNamespacedPod({
            name: id,
            namespace: "workspaces",
          });

          const age = dayjs.duration(dayjs().diff(pod.status!.startTime!));

          await message.edit({
            content: `Your workspace lasted ${age.humanize()}`,
            components: [],
          });

          await k8sCore.deleteNamespacedPod({
            name: id,
            namespace: "workspaces",
          });

          await k8sCore.deleteNamespacedService({
            name: id,
            namespace: "workspaces",
          });

          await k8sNetworking.deleteNamespacedIngress({
            name: id,
            namespace: "workspaces",
          });

          await k8sCore.deleteNamespacedConfigMap({
            name: id,
            namespace: "workspaces",
          });

          botChannel.send({
            content: `Automatically deleted workspace for <@${interaction.user.id}>`,
            allowedMentions: { parse: [] },
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
                    url: `https://workspace.osucyber.club/${interaction.user.id}/login?password=${password}`,
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

    console.log(
      `Created workspace for ${interaction.user.username} ${interaction.user.id}`
    );

    botChannel.send({
      content: `Created workspace for <@${interaction.user.id}>`,
      allowedMentions: { parse: [] },
    });

    await interaction.editReply({
      content: `Workspace created! It will expire <t:${Math.floor(
        endTime.getTime() / 1000
      )}:F>`,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              url: `https://workspace.osucyber.club/${interaction.user.id}/login?password=${password}`,
              label: "Open workspace",
            },
          ],
        },
      ],
    });
  },
};

const listWorkspaces: Command = {
  name: "wadmin",
  description: "Linux workspace management",
  options: [
    {
      name: "list",
      type: ApplicationCommandOptionType.Subcommand,
      description: "List existing workspaces (admin only)",
    },
  ],
  async run(interaction) {
    const roles = interaction.member?.roles as GuildMemberRoleManager;
    // only admin role can run this command
    if (!roles.cache.some((role) => role.id === "796887971512320040")) {
      await interaction.reply({
        content: "You do not have permission to run this command!",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const pods = await k8sCore.listNamespacedPod({ namespace: "workspaces" });
    const workspacePods = pods.items.filter(
      (pod) => pod.metadata?.labels?.workspace === "true"
    );

    const workspaces = workspacePods.map((pod) => {
      const discordId = pod.metadata?.labels?.["discordId"]!;
      const password = pod.metadata?.labels?.["password"];

      return {
        url: `https://workspace.osucyber.club/${discordId}/login?password=${password}`,
        discordId,
      };
    });

    await interaction.editReply({
      content:
        "Here are the current workspaces:\n\n" +
        workspaces
          .map(
            (workspace) =>
              `<@${workspace.discordId}> [Open workspace](${workspace.url})`
          )
          .join("\n"),
      allowedMentions: { parse: [] },
    });
  },
};

const commands = [createWorkspace, listWorkspaces];

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands);

  const pods = await k8sCore.listNamespacedPod({ namespace: "workspaces" });
  pods.items.forEach(async (pod) => {
    if (pod.metadata?.labels?.workspace === "true") {
      await k8sCore.deleteNamespacedPod({
        name: pod.metadata.name!,
        namespace: "workspaces",
      });
    }
  });

  const services = await k8sCore.listNamespacedService({
    namespace: "workspaces",
  });
  services.items.forEach(async (service) => {
    if (service.metadata?.name?.startsWith("workspace-")) {
      await k8sCore.deleteNamespacedService({
        name: service.metadata.name,
        namespace: "workspaces",
      });
    }
  });

  const ingresses = await k8sNetworking.listNamespacedIngress({
    namespace: "workspaces",
  });
  ingresses.items.forEach(async (ingress) => {
    if (ingress.metadata?.name?.startsWith("workspace-")) {
      await k8sNetworking.deleteNamespacedIngress({
        name: ingress.metadata.name,
        namespace: "workspaces",
      });
    }
  });

  const configmaps = await k8sCore.listNamespacedConfigMap({
    namespace: "workspaces",
  });
  configmaps.items.forEach(async (configmap) => {
    if (configmap.metadata?.name?.startsWith("workspace-")) {
      await k8sCore.deleteNamespacedConfigMap({
        name: configmap.metadata.name,
        namespace: "workspaces",
      });
    }
  });

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

client.login(process.env.DISCORD_BOT_TOKEN);
