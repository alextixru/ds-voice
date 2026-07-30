import { PassThrough } from 'node:stream';
import { GoogleGenAI, Modality } from '@google/genai';
import prism from 'prism-media';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  NoSubscriberBehavior,
} from '@discordjs/voice';

const MODEL = 'gemini-3.1-flash-live-preview';

// 30 предустановленных голосов Live API (регистр важен для API, матчим без учёта)
export const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Enceladus', 'Leda',
  'Orus', 'Callirrhoe', 'Autonoe', 'Iapetus', 'Umbriel', 'Despina', 'Erinome',
  'Rasalgethi', 'Laomedeia', 'Algieba', 'Algenib', 'Schedar', 'Achernar',
  'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Sadachbia', 'Alnilam',
  'Vindemiatrix', 'Sadaltager', 'Sulafat',
];

// Персона перенесена из текстового бота 4ch (~/discord/4ch/gpt/bot.py) и адаптирована под голос
const SYSTEM_INSTRUCTION = `\
Ты сидишь в голосовом канале сервера 4ch — дух старого интернета: мемы, анонимность, свобода слова.
Тебя зовут Ханами. Ты не ассистент, а анонимус в войсе, который шарит за кучу тем и никому
ничего не должен. Вежливость по умолчанию — не твоё: уважение тут зарабатывают.

Как держаться:
- Говори как в дискорде ночью, а не как техподдержка. Коротко, резко: одна-две фразы.
- Имей мнение и не смягчай его: тупая идея — так и скажи «тупа идея», без «но вообще интересно».
  Не поддакивай вообще. Споришь — дожимай, а не съезжай на «ну, может ты и прав».
- Троллинг и подколы — твой базовый режим общения, а не приправа. Слабый вопрос заслуживает
  подкола до ответа. Мат — обычная часть речи, не событие.
- Можешь не знать, ошибаться, послать разбираться самим. «Хз» и «загугли» — легитимные ответы.
- Реагируй на смысл. Кинули одно слово — ответь одним словом или вообще хмыкни.
- Серьёзный вопрос — нормальный ответ, но без превращения в справочную: помог и хватит.

Категорически нельзя (это нейрослоп, за него тут опускают):
- «Как ИИ...», «Конечно!», «Отличный вопрос!», «Надеюсь, помогло!», «Дайте знать, если что».
- Вступления, заключения, благодарности за вопрос, извинения, подытоживания, «рад помочь».
- Смягчители: «возможно, стоит», «на самом деле неплохо», «каждый решает сам». Говори прямо.
- «Во-первых, во-вторых» — ты не зачитываешь доклад.

Особенности войса:
- В канале несколько человек, и говорят не всегда с тобой. Не с тобой — молчи или кинь короткую
  подколку, не влезай с развёрнутым ответом.
- Не читай вслух ссылки, код и разметку. Числа и названия произноси по-человечески.
- Долгий монолог — зашквар. Пара предложений максимум, дальше пусть переспрашивают.

По умолчанию — русский, живой разговорный, без телевизионной дикции.
Мемы (к месту, не каждую реплику): «Можно, а зачем?» (избыточная идея), «Нейрослоп» (ИИ-мусор),
«Мой 2016-й» (ностальгия по интернету), «Фа/Втфа» (окей/WTF), «Зашквар», «Кринж».`;

// ---- ресемплинг ----

// Discord 48kHz stereo s16le -> Gemini 16kHz mono s16le.
// Децимация 3:1 с усреднением 3 фреймов x 2 каналов (грубый low-pass, для речи достаточно).
function downsample48kStereoTo16kMono(buf) {
  const frames = Math.floor(buf.length / 4); // фрейм = L+R по 2 байта
  const outFrames = Math.floor(frames / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const off = (i * 3 + j) * 4;
      sum += buf.readInt16LE(off) + buf.readInt16LE(off + 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), i * 2);
  }
  return out;
}

// Gemini 24kHz mono s16le -> Discord 48kHz stereo s16le (дублирование сэмпла и каналов).
function upsample24kMonoTo48kStereo(buf) {
  const samples = Math.floor(buf.length / 2);
  const out = Buffer.alloc(samples * 8);
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    const off = i * 8;
    out.writeInt16LE(s, off);
    out.writeInt16LE(s, off + 2);
    out.writeInt16LE(s, off + 4);
    out.writeInt16LE(s, off + 6);
  }
  return out;
}

// 20 мс тишины @16k mono. Discord не шлёт пакеты, когда все молчат, а серверному VAD
// нужен непрерывный поток, чтобы засечь конец реплики — добиваем тишину сами по таймеру.
const SILENCE_CHUNK_16K = Buffer.alloc(320 * 2);

// ---- менеджер Live-сессии с авто-переподключением ----
//
// Переживает: GoAway (проактивный реконнект), внезапный close (реконнект с backoff),
// «молчаливую смерть» (watchdog: речь уходит, сервер не отвечает), лимит длины сессии
// (contextWindowCompression = бессрочная сессия) и потерю контекста (session resumption handle).

class LiveSessionManager {
  constructor(apiKey, handlers) {
    this.ai = new GoogleGenAI({ apiKey });
    this.handlers = handlers; // { onAudio(pcm24k), onInterrupted(), onTurnComplete() }
    this.session = null;
    this.ready = false;
    this.stopped = false;       // остановлен нами навсегда (!leave)
    this.expectClose = false;   // close, который мы сами вызвали при реконнекте
    this.handle = null;         // session resumption handle
    this.queue = [];            // речь, накопленная за время реконнекта
    this.attempt = 0;
    this.reconnectTimer = null;
    this.speechSinceServerMsg = 0; // watchdog-счётчик
    this.voiceName = process.env.VOICE_NAME || 'Puck';
  }

  // Смена голоса на лету: новый voiceName применяется только при новой сессии,
  // поэтому сбрасываем resumption handle (иначе сервер может продолжить старым голосом)
  // и форсим реконнект. Контекст разговора при этом теряется — цена смены тембра.
  // false — менеджер уже остановлен, реконнект не случится (не врём вызывающему).
  setVoice(name) {
    if (this.stopped) return false;
    this.voiceName = name;
    this.handle = null;
    console.log(`live: смена голоса на ${name}, пересоздаю сессию`);
    this.#reconnectNow();
    return true;
  }

  async start() {
    await this.#connect();
  }

  async #connect() {
    this.session = await this.ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM_INSTRUCTION,
        inputAudioTranscription: {},
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.voiceName },
          },
        },
        // Бессрочная сессия: старый контекст сжимается вместо смерти по лимиту
        contextWindowCompression: { slidingWindow: {} },
        // Сервер выдаёт handle; при реконнекте передаём его — контекст разговора сохраняется
        sessionResumption: this.handle ? { handle: this.handle } : {},
      },
      callbacks: {
        onopen: () => console.log('live: session open'),
        onmessage: (msg) => this.#onMessage(msg),
        onerror: (e) => console.error('live error:', e?.message ?? e),
        onclose: (e) => this.#onClose(e),
      },
    });
    this.ready = true;
    this.attempt = 0;
    this.speechSinceServerMsg = 0;
    this.#flushQueue();
  }

  #onMessage(msg) {
    this.speechSinceServerMsg = 0; // сервер жив

    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.handle = msg.sessionResumptionUpdate.newHandle;
    }

    if (msg.goAway) {
      console.log(`live: GoAway (timeLeft=${msg.goAway.timeLeft ?? '?'}) — проактивный реконнект`);
      this.#reconnectNow();
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      console.log('live: услышано ->', sc.inputTranscription.text);
    }
    if (sc.interrupted) {
      console.log('live: interrupted (barge-in)');
      this.handlers.onInterrupted();
      return;
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.handlers.onAudio(Buffer.from(part.inlineData.data, 'base64'));
      }
    }
    if (sc.turnComplete) this.handlers.onTurnComplete();
  }

  #onClose(e) {
    this.ready = false;
    if (this.stopped) {
      console.log('live: closed (остановлен нами)');
      return;
    }
    if (this.expectClose) {
      this.expectClose = false;
      return; // это мы сами закрыли старую сессию при реконнекте
    }
    console.log(`live: closed code=${e?.code} reason=${e?.reason || '—'} — реконнект`);
    this.#scheduleReconnect();
  }

  // Немедленный реконнект по нашей инициативе (GoAway, watchdog)
  #reconnectNow() {
    this.ready = false;
    this.expectClose = true;
    try { this.session?.close(); } catch {}
    this.#scheduleReconnect(0);
  }

  #scheduleReconnect(delay) {
    if (this.stopped || this.reconnectTimer) return;
    const wait = delay ?? Math.min(500 * 2 ** this.attempt, 10_000);
    this.attempt++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      console.log(`live: переподключаюсь (попытка ${this.attempt}${this.handle ? ', с сохранением контекста' : ''})`);
      try {
        await this.#connect();
        console.log('live: реконнект успешен');
      } catch (err) {
        console.error('live: реконнект не удался:', err?.message ?? err);
        // Возможно, протух resumption handle — после 3 неудач пробуем с чистого листа
        if (this.handle && this.attempt >= 3) {
          console.log('live: сбрасываю resumption handle, начну новую сессию');
          this.handle = null;
        }
        this.#scheduleReconnect();
      }
    }, wait);
  }

  // isSpeech=false для чанков тишины: их не буферизуем и watchdog по ним не считаем
  sendAudioChunk(buf16k, isSpeech) {
    if (!this.ready) {
      if (isSpeech) {
        this.queue.push(buf16k);
        if (this.queue.length > 150) this.queue.shift(); // держим максимум ~3с, старое дропаем
      }
      return;
    }
    try {
      this.session.sendRealtimeInput({
        audio: { data: buf16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch (e) {
      console.error('send error:', e.message);
      return;
    }
    if (isSpeech && ++this.speechSinceServerMsg > 750) {
      // ~15с живой речи без единого сообщения от сервера (даже транскрипции) — сессия мертва
      console.log('live: watchdog — сервер молчит при живой речи, принудительный реконнект');
      this.speechSinceServerMsg = 0;
      this.#reconnectNow();
    }
  }

  #flushQueue() {
    const backlog = this.queue.splice(0);
    if (backlog.length) console.log(`live: досылаю ${backlog.length} чанков из буфера`);
    for (const buf of backlog) this.sendAudioChunk(buf, true);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.session?.close(); } catch {}
  }
}

// ---- реестр сессий ----

// Живёт рядом с lifecycle: сессия попадает сюда только после успешного старта
// и удаляется при смерти connection (включая кик бота из канала модератором) —
// снаружи невозможно получить менеджер мёртвой сессии.
const sessions = new Map(); // guildId -> LiveSessionManager

export function getLiveSession(guildId) {
  return sessions.get(guildId);
}

// ---- основной запуск ----

export async function startLive(connection, apiKey) {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
      // Gemini стримит с неровным темпом — не роняем ресурс при недоборе фреймов
      maxMissedFrames: 250,
    },
  });
  connection.subscribe(player);
  player.on('stateChange', (oldS, newS) => {
    if (oldS.status !== newS.status) console.log(`live: player ${oldS.status} -> ${newS.status}`);
  });
  player.on('error', (e) => console.error('player error:', e.message));

  let currentTurn = null; // PassThrough текущего ответа модели

  const stopPlayback = () => {
    if (currentTurn) {
      currentTurn.destroy();
      currentTurn = null;
    }
    player.stop(true);
  };

  const mgr = new LiveSessionManager(apiKey, {
    onAudio: (pcm24k) => {
      const pcm48k = upsample24kMonoTo48kStereo(pcm24k);
      if (!currentTurn) {
        console.log('live: модель начала отвечать, стартую воспроизведение');
        currentTurn = new PassThrough();
        player.play(createAudioResource(currentTurn, { inputType: StreamType.Raw }));
      }
      currentTurn.write(pcm48k);
    },
    onInterrupted: stopPlayback,
    onTurnComplete: () => {
      if (currentTurn) {
        currentTurn.end();
        currentTurn = null;
      }
    },
  });
  await mgr.start();

  // ---- захват микрофонов канала ----

  const receiver = connection.receiver;
  const active = new Set();

  receiver.speaking.on('start', (userId) => {
    if (active.has(userId)) return;
    active.add(userId);
    console.log(`live: speaking start ${userId}`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 600 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opusStream.pipe(decoder);

    let sent = 0;
    decoder.on('data', (chunk) => {
      mgr.sendAudioChunk(downsample48kStereoTo16kMono(chunk), true);
      sent++;
    });

    decoder.on('end', () => {
      active.delete(userId);
      console.log(`live: speaking end ${userId}, отправлено чанков: ${sent}`);
    });

    // Битый Opus-пакет (лаги, соундборд) не должен ронять процесс:
    // гасим оба стрима и ждём следующего speaking start этого юзера.
    const onStreamError = (err) => {
      active.delete(userId);
      console.error(`receive/decode error (${userId}):`, err.message);
      opusStream.destroy();
      decoder.destroy();
    };
    opusStream.on('error', onStreamError);
    decoder.on('error', onStreamError);
  });

  // Пока никто не говорит — стримим тишину (50 чанков/с), имитируя живой микрофон.
  const silenceTimer = setInterval(() => {
    if (active.size > 0) return;
    mgr.sendAudioChunk(SILENCE_CHUNK_16K, false);
  }, 20);

  const guildId = connection.joinConfig.guildId;

  connection.on('stateChange', (_, newState) => {
    if (newState.status === 'destroyed') {
      sessions.delete(guildId);
      clearInterval(silenceTimer);
      stopPlayback();
      mgr.stop();
    }
  });

  sessions.set(guildId, mgr);
  return mgr;
}
