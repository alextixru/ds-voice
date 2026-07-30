import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { startEcho } from './echo.js';
import { startLive, VOICES } from './live.js';

// Live-менеджер по гильдии — нужен для смены голоса на лету (!voice)
const liveSessions = new Map();

// Последний рубеж: не даём случайной ошибке в аудио-тракте убить бота посреди разговора.
process.on('uncaughtException', (e) => console.error('UNCAUGHT:', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Готов: ${c.user.tag}`);
});

async function joinChannel(message) {
  const channel = message.member?.voice?.channel;
  if (!channel) {
    await message.reply('Сначала зайди в голосовой канал.');
    return null;
  }

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
    await message.reply('Не смог подключиться к каналу (таймаут).');
    return null;
  }
  return { connection, channel };
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  if (message.content === '!join') {
    if (!process.env.GEMINI_API_KEY) {
      await message.reply('Нет `GEMINI_API_KEY` в .env — доступен только `!echo`.');
      return;
    }
    const joined = await joinChannel(message);
    if (!joined) return;
    try {
      const mgr = await startLive(joined.connection, process.env.GEMINI_API_KEY);
      liveSessions.set(message.guild.id, mgr);
    } catch (e) {
      console.error('startLive failed:', e);
      joined.connection.destroy();
      await message.reply(`Не смог открыть Live-сессию: ${e.message}`);
      return;
    }
    await message.reply(`Зашёл в **${joined.channel.name}**. Говори — я слушаю.`);
  }

  if (message.content === '!echo') {
    const joined = await joinChannel(message);
    if (!joined) return;
    startEcho(joined.connection);
    await message.reply(`Зашёл в **${joined.channel.name}**. Режим: эхо.`);
  }

  if (message.content.startsWith('!voice')) {
    const arg = message.content.slice('!voice'.length).trim();
    const mgr = liveSessions.get(message.guild.id);
    if (!arg) {
      const current = mgr ? mgr.voiceName : (process.env.VOICE_NAME || 'Puck');
      await message.reply(
        `Сейчас: **${current}**. Смена: \`!voice <имя>\`\nДоступные: ${VOICES.join(', ')}`,
      );
      return;
    }
    const voice = VOICES.find((v) => v.toLowerCase() === arg.toLowerCase());
    if (!voice) {
      await message.reply(`Не знаю голос \`${arg}\`. Список: \`!voice\``);
      return;
    }
    if (!mgr) {
      await message.reply('Live-сессия не запущена — сначала `!join`.');
      return;
    }
    mgr.setVoice(voice);
    await message.reply(`Голос: **${voice}**. Пару секунд на пересоздание сессии (контекст разговора сбросится).`);
  }

  if (message.content === '!leave') {
    const connection = getVoiceConnection(message.guild.id);
    if (connection) {
      connection.destroy();
      liveSessions.delete(message.guild.id);
      await message.reply('Вышел.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
