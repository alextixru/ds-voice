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

// Гильдии, где разрешён войс: бот добавлен на публичные сервера с десятками тысяч людей,
// без белого списка любой их участник may /join и выжечь квоту Gemini (и 3 одновременные
// Live-сессии free tier). Вне списка — отказ со ссылкой на владельца.
const GUILD_ALLOWLIST = new Set(
  (process.env.GUILD_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
let ownerMention = 'владельцу бота';

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
  // Владелец приложения — для контакта в отказе на чужих серверах
  try {
    const app = await c.application.fetch();
    const owner = app.owner?.owner?.user ?? app.owner; // team или личный аккаунт
    if (owner?.id) ownerMention = `<@${owner.id}>`;
  } catch (e) {
    console.error('не смог получить владельца приложения:', e.message);
  }
  console.log(`Готов: ${c.user.tag}, слэш-команды зарегистрированы, allowlist: ${GUILD_ALLOWLIST.size} гильдий`);
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

  // Слепых зон не оставляем: заходы/выходы людей дёргают войс (re-key, перенос канала),
  // и до сих пор это было видно только как «player -> autopaused» посреди фразы.
  connection.on('stateChange', (oldS, newS) => {
    if (oldS.status !== newS.status) console.log(`voice: ${oldS.status} -> ${newS.status}`);
  });

  // Канонический паттерн из гайда discord.js: Disconnected ещё не смерть — даём 5с
  // на самовосстановление (Signalling/Connecting = перенос канала или re-resume),
  // и только если не ожило — destroy, чтобы не висеть зомби. Live-сессия погаснет
  // сама через stateChange=destroyed.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log('voice: disconnect оказался переносом/resume — живём');
    } catch {
      console.log('voice: реальный дисконнект — закрываю соединение');
      connection.destroy();
    }
  });

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

  // Войс-команды — только на разрешённых серверах (/leave не гейтим: выйти можно всегда)
  if (
    ['join', 'echo', 'voice'].includes(interaction.commandName) &&
    !GUILD_ALLOWLIST.has(interaction.guild.id)
  ) {
    await interaction.reply({
      content: `На этом сервере голосовой режим не подключён. Подключение платное — пишите ${ownerMention}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

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
      await startLive(joined.connection, process.env.GEMINI_API_KEY, {
        // Уведомления (смена голоса и т.п.) — в канал, откуда позвали бота
        announce: (text) => interaction.channel?.send(text).catch(() => {}),
      });
    } catch (e) {
      console.error('startLive failed:', e);
      // Соединение могло уже погибнуть (гонка параллельных /join) — повторный destroy кинет
      if (joined.connection.state.status !== 'destroyed') joined.connection.destroy();
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
      const current = mgr ? mgr.voiceName : (process.env.VOICE_NAME || 'Leda');
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
