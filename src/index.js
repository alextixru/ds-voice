import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  getVoiceConnections,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { startEcho } from './echo.js';
import { startLive, getLiveSession, VOICES } from './live.js';

// Последний рубеж: не даём случайной ошибке в аудио-тракте убить бота посреди разговора.
process.on('uncaughtException', (e) => console.error('UNCAUGHT:', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e));

// Слэш-команды не требуют привилегированных интентов (MessageContent больше не нужен):
// Guilds — база для interactions, GuildVoiceStates — чтобы видеть, кто в каком войсе.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Позвать Ханами в твой голосовой канал'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Выгнать бота из голосового канала'),
  new SlashCommandBuilder()
    .setName('echo')
    .setDescription('Зайти в канал в режиме эха (отладка звука)'),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Показать или сменить голос Ханами')
    .addStringOption((o) =>
      o
        .setName('имя')
        .setDescription('Один из 30 голосов Gemini (сессия пересоздастся, контекст сбросится)')
        .setAutocomplete(true),
    ),
];

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands);
  console.log(`Готов: ${c.user.tag}, слэш-команды зарегистрированы`);
});

// interaction должен быть deferred: entersState ждёт до 15с, а на ответ даётся 3с
async function joinChannel(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    await interaction.editReply('Сначала зайди в голосовой канал.');
    return null;
  }

  // Идемпотентность: повторный /join (или /echo поверх live) не должен навешивать
  // второй комплект листенеров на существующий connection — joinVoiceChannel вернул бы
  // его же. Сносим старый: его live-сессия погаснет сама через stateChange=destroyed.
  getVoiceConnection(channel.guild.id)?.destroy();

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // иначе бот не будет слышать канал
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    await interaction.editReply('Не смог подключиться к каналу (таймаут).');
    return null;
  }
  return { connection, channel };
}

client.on(Events.InteractionCreate, async (interaction) => {
  // Автокомплит для /voice: Discord отдаёт максимум 25 подсказок, голосов 30 —
  // поэтому фильтруем по подстроке, а не отдаём статичный список
  if (interaction.isAutocomplete()) {
    const q = interaction.options.getFocused().toLowerCase();
    const matches = VOICES.filter((v) => v.toLowerCase().includes(q)).slice(0, 25);
    await interaction.respond(matches.map((v) => ({ name: v, value: v })));
    return;
  }

  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.commandName === 'join') {
    if (!process.env.GEMINI_API_KEY) {
      await interaction.reply({
        content: 'Нет `GEMINI_API_KEY` в .env — доступен только `/echo`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    const joined = await joinChannel(interaction);
    if (!joined) return;
    try {
      await startLive(joined.connection, process.env.GEMINI_API_KEY);
    } catch (e) {
      console.error('startLive failed:', e);
      joined.connection.destroy();
      await interaction.editReply(`Не смог открыть Live-сессию: ${e.message}`);
      return;
    }
    await interaction.editReply(`Зашёл в **${joined.channel.name}**. Говори — я слушаю.`);
  }

  if (interaction.commandName === 'echo') {
    await interaction.deferReply();
    const joined = await joinChannel(interaction);
    if (!joined) return;
    startEcho(joined.connection);
    await interaction.editReply(`Зашёл в **${joined.channel.name}**. Режим: эхо.`);
  }

  if (interaction.commandName === 'voice') {
    const arg = interaction.options.getString('имя');
    const mgr = getLiveSession(interaction.guild.id);
    if (!arg) {
      const current = mgr ? mgr.voiceName : (process.env.VOICE_NAME || 'Puck');
      await interaction.reply({
        content: `Сейчас: **${current}**. Смена: \`/voice имя:<голос>\`\nДоступные: ${VOICES.join(', ')}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Автокомплит — подсказка, не валидация: юзер может отправить произвольный текст
    const voice = VOICES.find((v) => v.toLowerCase() === arg.toLowerCase());
    if (!voice) {
      await interaction.reply({
        content: `Не знаю голос \`${arg}\`. Пустой \`/voice\` покажет список.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!mgr || !mgr.setVoice(voice)) {
      await interaction.reply({
        content: 'Live-сессия не запущена — сначала `/join`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply(
      `Голос: **${voice}**. Пару секунд на пересоздание сессии (контекст разговора сбросится).`,
    );
  }

  if (interaction.commandName === 'leave') {
    const connection = getVoiceConnection(interaction.guild.id);
    if (!connection) {
      await interaction.reply({ content: 'Я и так не в канале.', flags: MessageFlags.Ephemeral });
      return;
    }
    connection.destroy(); // live-сессия погаснет сама через stateChange=destroyed
    await interaction.reply('Вышел.');
  }
});

// Graceful shutdown: выходим из войсов и гасим клиент, чтобы бот не висел
// «призраком» в канале после рестарта (launchd шлёт SIGTERM при выгрузке).
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} — выхожу из каналов и завершаюсь`);
  for (const connection of getVoiceConnections().values()) {
    try { connection.destroy(); } catch {}
  }
  client.destroy();
  // Секунда на то, чтобы гейтвей успел получить disconnect
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

client.login(process.env.DISCORD_TOKEN);
