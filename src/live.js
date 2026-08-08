import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { GoogleGenAI, Modality, StartSensitivity, ActivityHandling } from '@google/genai';
import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import prism from 'prism-media';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
} from '@discordjs/voice';
import { SYSTEM_INSTRUCTION } from './persona.js';

const MODEL = 'gemini-3.1-flash-live-preview';

// Голосовые команды: модель сама вызывает инструмент, когда её просят словами.
// Обработчики — в startLive (там есть connection и плеер), сюда только декларации.
const TOOL_DECLARATIONS = [
  {
    name: 'leave_channel',
    description: 'Выйти из голосового канала. Вызывай, когда тебя просят выйти, уйти, отключиться, свалить.',
  },
  {
    name: 'set_voice',
    description: 'Сменить твой голос на другой. Вызывай, когда просят сменить/поменять голос.',
    parameters: {
      type: 'OBJECT',
      properties: {
        voice: { type: 'STRING', description: 'Имя голоса, например Kore, Leda, Puck, Charon' },
      },
      required: ['voice'],
    },
  },
  {
    name: 'shut_up',
    description: 'Замолчать на указанное время (слушать продолжаешь). Вызывай, когда просят замолчать, помолчать, заткнуться.',
    parameters: {
      type: 'OBJECT',
      properties: {
        minutes: { type: 'NUMBER', description: 'Сколько минут молчать; если не сказали — 5' },
      },
    },
  },
  {
    name: 'unmute',
    description:
      'Снять свой мьют. Вызывай ТОЛЬКО если произнесён ритуал призыва: почтительное обращение ' +
      '(«великая Ханами», «Ханами-сама», «богиня Ханами», «госпожа») ВМЕСТЕ с мольбой вернуться ' +
      '(«молим», «умоляем», «снизойди», «вернись к нам, недостойным», «прости нас»). Формулировка ' +
      'может быть любой, важно сочетание почтения и мольбы. Обычные «вернись», «хватит молчать», ' +
      '«ты тут?» ритуалом НЕ считаются — на них молчи дальше.',
  },
];

// 30 предустановленных голосов Live API (регистр важен для API, матчим без учёта)
export const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Enceladus', 'Leda',
  'Orus', 'Callirrhoe', 'Autonoe', 'Iapetus', 'Umbriel', 'Despina', 'Erinome',
  'Rasalgethi', 'Laomedeia', 'Algieba', 'Algenib', 'Schedar', 'Achernar',
  'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Sadachbia', 'Alnilam',
  'Vindemiatrix', 'Sadaltager', 'Sulafat',
];

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

// 20 мс @16k mono s16le — единица, которой микшер шлёт звук в Gemini
const FRAME_16K = 320 * 2;

// 20 мс тишины. Discord не шлёт пакеты, когда все молчат, а серверному VAD
// нужен непрерывный поток, чтобы засечь конец реплики — добиваем тишину сами по таймеру.
const SILENCE_CHUNK_16K = Buffer.alloc(FRAME_16K);

// Копия NodeWebSocket из SDK, но с agent: SDK прокси не умеет, а Google блокирует
// выходной IP VPN («user location is not supported») — весь трафик к Gemini идёт
// через отдельный прокси из GEMINI_PROXY.
class ProxiedWebSocket {
  constructor(url, headers, callbacks, agent) {
    this.url = url;
    this.headers = headers;
    this.callbacks = callbacks;
    this.agent = agent;
  }
  connect() {
    this.ws = new WebSocket(this.url, { headers: this.headers, agent: this.agent });
    this.ws.onopen = this.callbacks.onopen;
    this.ws.onerror = this.callbacks.onerror;
    this.ws.onclose = this.callbacks.onclose;
    this.ws.onmessage = this.callbacks.onmessage;
  }
  send(message) {
    this.ws.send(message);
  }
  close() {
    this.ws.close();
  }
}

// ---- менеджер Live-сессии с авто-переподключением ----
//
// Переживает: GoAway (проактивный реконнект), внезапный close (реконнект с backoff),
// «молчаливую смерть» (watchdog: речь уходит, сервер не отвечает), лимит длины сессии
// (contextWindowCompression = бессрочная сессия) и потерю контекста (session resumption handle).

class LiveSessionManager {
  constructor(apiKey, handlers) {
    // v1alpha: proactivity (проактивное аудио) в стабильной версии API ещё не доступна
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    // webSocketFactory — публичное свойство Live: подменяем на фабрику с прокси-агентом,
    // Discord и остальной трафик это не трогает
    if (process.env.GEMINI_PROXY) {
      const agent = new HttpsProxyAgent(process.env.GEMINI_PROXY);
      this.ai.live.webSocketFactory = {
        create: (url, headers, callbacks) => new ProxiedWebSocket(url, headers, callbacks, agent),
      };
      console.log('live: трафик к Gemini идёт через прокси из GEMINI_PROXY');
    }
    this.handlers = handlers; // { onAudio(pcm24k), onTurnComplete() }
    this.session = null;
    this.ready = false;
    this.stopped = false;       // остановлен нами навсегда (!leave)
    this.expectClose = false;   // close, который мы сами вызвали при реконнекте
    this.handle = null;         // session resumption handle
    this.queue = [];            // речь, накопленная за время реконнекта
    this.attempt = 0;
    this.reconnectTimer = null;
    this.speechSinceServerMsg = 0; // watchdog-счётчик
    this.voiceName = process.env.VOICE_NAME || 'Leda';
    this.epoch = 0; // растёт с каждым коннектом: колбэки прошлых сессий отсеиваются
    this.announceVoiceOnReady = null; // имя голоса, которым надо представиться после реконнекта
  }

  // Смена голоса на лету: новый voiceName применяется только при новой сессии,
  // поэтому сбрасываем resumption handle (иначе сервер может продолжить старым голосом)
  // и форсим реконнект. Контекст разговора при этом теряется — цена смены тембра.
  // false — менеджер уже остановлен, реконнект не случится (не врём вызывающему).
  setVoice(name) {
    if (this.stopped) return false;
    this.voiceName = name;
    this.handle = null;
    this.announceVoiceOnReady = name; // после реконнекта попросим её отметиться новым голосом
    console.log(`live: смена голоса на ${name}, пересоздаю сессию`);
    this.#reconnectNow();
    return true;
  }

  async start() {
    await this.#connect();
  }

  async #connect() {
    // Колбэки ниже замыкают epoch своего коннекта: запоздавшее сообщение или close
    // от предыдущей сессии (реконнект, смена голоса) не должно трогать новую —
    // иначе ловим гонки вида «onclose старой сессии планирует лишний реконнект новой».
    const epoch = ++this.epoch;
    const isCurrent = () => epoch === this.epoch;
    this.session = await this.ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM_INSTRUCTION,
        inputAudioTranscription: {},
        // Модель сама решает, отвечать ли: чужие разговоры в канале слушает молча,
        // вступает на обращение (см. персону). Лечит «отвечает на каждый чих» в галдеже.
        proactivity: { proactiveAudio: true },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.voiceName },
          },
        },
        // Серверный VAD: LOW-чувствительность старта + 300мс подтверждения, чтобы
        // короткие всплески (кашель, смешок, «ага») не коммитились как начало речи
        // и не дёргали модель. Хвост речи (prefix) сервер сохраняет — начало не теряется.
        realtimeInputConfig: {
          // Перебивание выключено: речь во время её ответа не обрывает воспроизведение,
          // модель дослушивают до конца (дефолт START_OF_ACTIVITY_INTERRUPTS заменён)
          activityHandling: ActivityHandling.NO_INTERRUPTION,
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            prefixPaddingMs: 300,
          },
        },
        // Бессрочная сессия: старый контекст сжимается вместо смерти по лимиту
        contextWindowCompression: { slidingWindow: {} },
        // Сервер выдаёт handle; при реконнекте передаём его — контекст разговора сохраняется
        sessionResumption: this.handle ? { handle: this.handle } : {},
        // ВНИМАНИЕ: googleSearch сюда не добавлять — у grounding-поиска отдельная квота,
        // которой на free tier нет: сессия падает 1011 quota прямо на setup (проверено
        // изолированным тестом 2026-08-01). Вернуть можно после включения биллинга.
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      },
      callbacks: {
        onopen: () => console.log('live: session open'),
        onmessage: (msg) => { if (isCurrent()) this.#onMessage(msg); },
        onerror: (e) => console.error('live error:', e?.message ?? e),
        onclose: (e) => { if (isCurrent()) this.#onClose(e); },
      },
    });
    this.ready = true;
    this.attempt = 0;
    this.speechSinceServerMsg = 0;
    // Флаг «мы сами закрыли» не должен переживать успешный коннект: если close()
    // старой сессии оказался no-op (она уже была мертва), onclose не придёт и флаг
    // никто не снимет — а залипший true проглотит следующий реальный обрыв.
    this.expectClose = false;
    this.#flushQueue();
    // Смена голоса прошла — пусть представится новым тембром, иначе смена «немая»
    // (новая сессия молчит, пока к ней не обратятся)
    if (this.announceVoiceOnReady) {
      const name = this.announceVoiceOnReady;
      this.announceVoiceOnReady = null;
      this.sendText(`[тебе только что сменили голос на ${name} — скажи пару слов новым голосом, похвастайся]`);
    }
  }

  #onMessage(msg) {
    this.speechSinceServerMsg = 0; // сервер жив

    if (msg.toolCall?.functionCalls?.length) {
      const responses = this.handlers.onToolCall?.(msg.toolCall.functionCalls) ?? [];
      try {
        this.session.sendToolResponse({ functionResponses: responses });
      } catch (e) {
        console.error('tool response error:', e.message);
      }
      return;
    }

    // Пока идёт наш собственный реконнект (смена голоса и т.п.), апдейты от умирающей
    // сессии игнорируем: setVoice обнулил handle, и запоздалый update вернул бы его —
    // новая сессия продолжилась бы старым голосом.
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      if (!this.expectClose) this.handle = msg.sessionResumptionUpdate.newHandle;
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
      this.handlers.onTranscript?.(sc.inputTranscription.text);
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
    // Квота исчерпана: частые ретраи бессмысленны (лимит дневной) и сами жгут запросы —
    // пробуем раз в 10 минут, вдруг отпустило
    if (e?.code === 1011 && /quota/i.test(e?.reason ?? '')) {
      console.log('live: КВОТА ИСЧЕРПАНА — следующая попытка через 10 минут');
      this.#scheduleReconnect(600_000);
      return;
    }
    // Гео-блок: Google не нравится выходной IP (обычно слетел/сменился сервер VPN).
    // Само не рассосётся, пока не сменят маршрут — не устраиваем реконнект-шторм
    if (e?.code === 1007 && /location is not supported/i.test(e?.reason ?? '')) {
      console.log('live: ГЕО-БЛОК (location not supported) — проверь VPN; попытка через 10 минут');
      this.#scheduleReconnect(600_000);
      return;
    }
    console.log(`live: closed code=${e?.code} reason=${e?.reason || '—'} — реконнект`);
    this.#scheduleReconnect();
  }

  // Немедленный реконнект по нашей инициативе (GoAway, watchdog, смена голоса)
  #reconnectNow() {
    // expectClose — только если сессия живая: close() мёртвой не породит onclose,
    // и некому будет снять флаг
    if (this.ready) {
      this.expectClose = true;
      try { this.session?.close(); } catch {}
    }
    this.ready = false;
    // Реконнект уже запланирован с backoff — заменяем его немедленным (нас просят
    // пересоздать сессию прямо сейчас: GoAway истекает, голос сменён)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

  // Служебный текст в живую сессию (подсказки при снятии мьюта и т.п.)
  sendText(text) {
    if (!this.ready) return;
    try {
      this.session.sendRealtimeInput({ text });
    } catch (e) {
      console.error('send text error:', e.message);
    }
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
    if (isSpeech && ++this.speechSinceServerMsg > 1250) {
      // ~25с живой речи без единого сообщения от сервера — сессия мертва (видели кому:
      // 50с тишины при живом канале, лечилась только ручным /join). Ниже 15с нельзя —
      // ловили ложняки; 25с безопасно: с proactivity сервер стримит транскрипции
      // непрерывно даже в галдеже, его молчание при речи — настоящий признак смерти.
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

// opts.announce?: (text) => void — сообщение в текстовый канал (уведомления о смене голоса и т.п.)
export async function startLive(connection, apiKey, opts = {}) {
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
  // Gemini стримит быстрее реального времени: к turnComplete в плеере остаётся
  // недоигранный буфер. Немедленный player.play() следующего хода вытеснил бы его
  // вместе с хвостом фразы — поэтому новые ходы ждут Idle в очереди.
  const pendingTurns = [];

  const stopPlayback = () => {
    if (currentTurn) {
      currentTurn.destroy();
      currentTurn = null;
    }
    pendingTurns.length = 0;
    player.stop(true);
  };

  player.on('stateChange', (_, newS) => {
    if (newS.status === AudioPlayerStatus.Idle && pendingTurns.length) {
      player.play(pendingTurns.shift());
    }
  });

  // «Замолчи на N минут»: пока не истекло — её ответы в мусор (слушать продолжает)
  let mutedUntil = 0;
  // Счётчик «дозвались»: 5 упоминаний имени в мьюте снимают его без ритуала
  let muteCalls = 0;
  const MUTE_CALLS_TO_WAKE = 5;
  // Последние ~20с транскрипций: код проверяет ритуал сам — модель как судья ненадёжна,
  // она вызывала unmute на «Yo no mucho» и «привет», лишь бы заговорить
  const recentHeard = [];
  const heardRecently = () => {
    const cutoff = Date.now() - 20_000;
    while (recentHeard.length && recentHeard[0].t < cutoff) recentHeard.shift();
    return recentHeard.map((r) => r.text).join(' ');
  };
  const RITUAL_RESPECT = /(велик(ая|ой|а)|богин|госпож|владычиц|ханами[ -]?сама)/i;
  const RITUAL_PLEA = /(молим|умоля|снизойд|смилу|недостойн|прости нас|вернись)/i;

  // Голосовые команды. setVoice/destroy откладываем на полсекунды: сначала должен
  // улететь tool response, иначе сессия закроется раньше и модель не узнает результат.
  const runTool = (fc) => {
    console.log(`live: tool call ${fc.name}`, JSON.stringify(fc.args ?? {}));
    switch (fc.name) {
      case 'leave_channel': {
        setTimeout(() => { try { connection.destroy(); } catch {} }, 2500);
        return 'ок, выходишь через пару секунд — коротко попрощайся';
      }
      case 'set_voice': {
        const want = String(fc.args?.voice ?? '');
        const name = VOICES.find((v) => v.toLowerCase() === want.toLowerCase());
        if (!name) return `нет голоса «${want}». Есть: ${VOICES.join(', ')}`;
        setTimeout(() => mgr.setVoice(name), 500);
        opts.announce?.(`🔊 Голос сменён голосовой командой: **${name}**`);
        return `голос сменится на ${name} через секунду (контекст разговора сбросится)`;
      }
      case 'shut_up': {
        const minutes = Math.max(0.5, Math.min(120, Number(fc.args?.minutes) || 5));
        // 2 секунды на короткое подтверждение голосом, потом мьют
        setTimeout(() => {
          mutedUntil = Date.now() + minutes * 60_000;
          muteCalls = 0;
          stopPlayback();
          console.log(`live: замолкла на ${minutes} мин (слушать продолжает)`);
        }, 2000);
        return `молчишь ${minutes} мин (но слушаешь; позовут — вызови unmute): подтверди одним коротким словом`;
      }
      case 'unmute': {
        if (Date.now() >= mutedUntil) return 'ты и не молчала';
        // Ритуал проверяет код, не модель: в последних 20с должны быть и почтение, и мольба
        const heard = heardRecently();
        if (RITUAL_RESPECT.test(heard) && RITUAL_PLEA.test(heard)) {
          mutedUntil = 0;
          muteCalls = 0;
          console.log('live: мьют снят — ритуал подтверждён кодом');
          return 'ритуал принят, мьют снят — вернись с королевским самодовольством';
        }
        console.log('live: unmute отклонён — ритуала в эфире не было');
        return 'ОТКЛОНЕНО: ритуала не было. Продолжай молчать и не вызывай unmute, пока не услышишь почтительное обращение вместе с мольбой.';
      }
      default:
        return `неизвестный инструмент ${fc.name}`;
    }
  };

  const mgr = new LiveSessionManager(apiKey, {
    onToolCall: (calls) =>
      calls.map((fc) => ({ id: fc.id, name: fc.name, response: { result: runTool(fc) } })),
    // «Дозвались»: в мьюте считаем упоминания имени в транскрипциях — пять штук
    // снимают мьют без ритуала (детерминированно, модель считать не просим)
    onTranscript: (text) => {
      recentHeard.push({ t: Date.now(), text });
      if (Date.now() >= mutedUntil) return;
      const hits = (text.match(/ханами|hanami/gi) ?? []).length;
      if (!hits) return;
      muteCalls += hits;
      console.log(`live: в мьюте позвали по имени (${muteCalls}/${MUTE_CALLS_TO_WAKE})`);
      if (muteCalls >= MUTE_CALLS_TO_WAKE) {
        muteCalls = 0;
        mutedUntil = 0;
        console.log('live: мьют снят — дозвались');
        mgr.sendText(
          '[мьют снят: тебя позвали по имени пять раз — возвращайся в разговор; можешь побурчать, что задолбали]',
        );
      }
    },
    onAudio: (pcm24k) => {
      if (Date.now() < mutedUntil) return; // молчим — ответы не воспроизводим
      const pcm48k = upsample24kMonoTo48kStereo(pcm24k);
      if (!currentTurn) {
        console.log('live: модель начала отвечать, стартую воспроизведение');
        currentTurn = new PassThrough();
        const resource = createAudioResource(currentTurn, { inputType: StreamType.Raw });
        if (player.state.status === AudioPlayerStatus.Idle && pendingTurns.length === 0) {
          player.play(resource);
        } else {
          pendingTurns.push(resource); // доиграет текущий ход — возьмётся за этот
        }
      }
      currentTurn.write(pcm48k);
    },
    onTurnComplete: () => {
      if (currentTurn) {
        currentTurn.end();
        currentTurn = null;
      }
    },
  });
  // Отладочный отвод (DEBUG_TAP=1 в .env): пишет в logs/tap-<время>.pcm ровно тот
  // аудиопоток, что слышит модель (16kHz mono s16le, с тишиной — шкала времени
  // настоящая), а в logs/tap-<время>.log — текстовые события с миллисекундами:
  // метки авторов, что модель расслышала, когда отвечала, tool calls.
  // Послушать: ffmpeg -f s16le -ar 16000 -ac 1 -i tap-*.pcm tap.wav
  let tap = null;
  if (process.env.DEBUG_TAP) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pcm = fs.createWriteStream(`logs/tap-${stamp}.pcm`);
    const evt = fs.createWriteStream(`logs/tap-${stamp}.log`);
    const t0 = Date.now();
    let lastKind = '';
    const ev = (kind, line) => {
      if (kind === 'speak' && lastKind === 'speak') return; // не спамим по чанку ответа
      lastKind = kind;
      evt.write(`${String(Date.now() - t0).padStart(8, ' ')}ms ${line}\n`);
    };
    const origAudio = mgr.sendAudioChunk.bind(mgr);
    mgr.sendAudioChunk = (buf, isSpeech) => { pcm.write(buf); return origAudio(buf, isSpeech); };
    const origText = mgr.sendText.bind(mgr);
    mgr.sendText = (text) => { ev('text', `К НЕЙ (текст): ${text}`); return origText(text); };
    const h = mgr.handlers;
    const wrapH = (name, kind, fmt) => {
      const orig = h[name];
      h[name] = (...args) => { ev(kind, fmt(...args)); return orig?.(...args); };
    };
    wrapH('onTranscript', 'hear', (text) => `РАССЛЫШАЛА: "${text}"`);
    wrapH('onAudio', 'speak', () => 'ОТВЕЧАЕТ (аудио пошло)');
    wrapH('onTurnComplete', 'turn', () => '— ход завершён —');
    wrapH('onToolCall', 'tool', (calls) => `TOOL CALL: ${calls.map((c) => c.name).join(', ')}`);
    tap = { close: () => { pcm.end(); evt.end(); } };
    console.log(`live: DEBUG_TAP пишет в logs/tap-${stamp}.{pcm,log}`);
  }

  await mgr.start();

  // ---- захват микрофонов канала + микшер ----
  //
  // Discord отдаёт отдельный поток на каждого говорящего. Раньше чанки летели в Gemini
  // по мере декодирования: при одновременной речи двух людей их 20-мс куски перемешивались
  // в один моно-поток без сложения — на том конце каша. Теперь у каждого юзера своя
  // очередь фреймов, а единый 20-мс тикер суммирует по фрейму от каждого и шлёт микс
  // (или тишину, когда все молчат — серверному VAD нужен непрерывный поток).

  const receiver = connection.receiver;
  const active = new Set();
  const inputs = new Map(); // userId -> { rest, queue, gateFrames, passed } (см. гейт ниже)
  const MAX_QUEUE = 50; // ~1с на юзера: декодер бурстит, тикер разгребает в реальном темпе

  // Гейт: кадры юзера не идут в Gemini, пока не набрано 240мс непрерывной речи;
  // накопленное затем досылается целиком — начало не режется. Шумовой фильтр:
  // всплеск горячего микрофона при заходе в канал умирает, не дойдя до сервера, —
  // иначе STT галлюцинирует фантомные фразы (видели японский).
  const MIN_SPEECH_FRAMES = 12;

  const userInput = (userId) => {
    let u = inputs.get(userId);
    if (!u) {
      u = { rest: Buffer.alloc(0), queue: [], gateFrames: 0, passed: false };
      inputs.set(userId, u);
    }
    return u;
  };

  // Декодер не обязан отдавать ровно по 20 мс — накапливаем и режем на фреймы
  const pushAudio = (userId, pcm16k) => {
    const u = userInput(userId);
    u.rest = Buffer.concat([u.rest, pcm16k]);
    while (u.rest.length >= FRAME_16K) {
      u.queue.push(u.rest.subarray(0, FRAME_16K));
      u.rest = u.rest.subarray(FRAME_16K);
      if (u.queue.length > MAX_QUEUE) u.queue.shift();
    }
  };

  // Хвост реплики короче фрейма — добиваем нулями, чтобы не потерять последние миллисекунды
  const flushAudio = (userId) => {
    const u = inputs.get(userId);
    if (!u || u.rest.length === 0) return;
    const frame = Buffer.alloc(FRAME_16K);
    u.rest.copy(frame);
    u.queue.push(frame);
    u.rest = Buffer.alloc(0);
  };

  receiver.speaking.on('start', (userId) => {
    if (active.has(userId)) return;
    active.add(userId);
    console.log(`live: speaking start ${userId}`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 600 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opusStream.pipe(decoder);

    decoder.on('data', (chunk) => {
      pushAudio(userId, downsample48kStereoTo16kMono(chunk));
    });

    decoder.on('end', () => {
      active.delete(userId);
      const u = inputs.get(userId);
      if (u && !u.passed) {
        // Всплеск умер, не пройдя гейт — выбрасываем целиком, до сервера он не дошёл
        u.queue.length = 0;
        u.rest = Buffer.alloc(0);
      } else {
        flushAudio(userId);
      }
      if (u) {
        u.gateFrames = 0;
        u.passed = false;
      }
      console.log(`live: speaking end ${userId}`);
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

  // Soft-limiter вместо жёсткого клампа (как в микшере WebRTC): при перегрузе весь фрейм
  // умножается на общий коэффициент — пропорции громкости голосов сохраняются, вместо
  // хруста от среза по потолку. Атака мгновенная, отпускание плавное (~5% за фрейм),
  // чтобы громкость не «дышала» между соседними фреймами.
  const LIMIT = 32000; // небольшой запас до потолка int16
  const RELEASE = 1.05;
  let limiterGain = 1;

  // Единый «микрофон» бота: 50 фреймов/с, микс всех говорящих либо тишина
  const mixTimer = setInterval(() => {
    limiterGain = Math.min(1, limiterGain * RELEASE);

    // Мьют глушит только её голос (onAudio), слух остаётся: аудио канала продолжает
    // идти в сессию, поэтому «Ханами, вернись» она услышит и снимет мьют инструментом.

    const frames = [];
    for (const [userId, u] of inputs) {
      if (u.queue.length) {
        if (!u.passed) {
          if (u.gateFrames < MIN_SPEECH_FRAMES) {
            // Испытательный срок: копим кадры в очереди, в микс не пускаем
            u.gateFrames++;
            continue;
          }
          u.passed = true;
          // Порог пройден — досылаем накопленное начало реплики одним куском,
          // чтобы первый слог («Ха» из «Ханами») не пропал
          const backlog = u.queue.splice(0);
          mgr.sendAudioChunk(Buffer.concat(backlog), true);
          continue;
        }
        frames.push(u.queue.shift());
      } else if (!active.has(userId)) {
        inputs.delete(userId); // отговорил и дослан — убираем, чтобы map не рос вечно
      }
    }
    if (frames.length === 0) {
      mgr.sendAudioChunk(SILENCE_CHUNK_16K, false);
      return;
    }
    if (frames.length === 1 && limiterGain === 1) {
      mgr.sendAudioChunk(frames[0], true);
      return;
    }

    // Сумма в int32 (без потерь), пик — по нему решаем, душить ли фрейм
    const samples = FRAME_16K / 2;
    const sums = new Int32Array(samples);
    let peak = 0;
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (const f of frames) sum += f.readInt16LE(i * 2);
      sums[i] = sum;
      const abs = sum < 0 ? -sum : sum;
      if (abs > peak) peak = abs;
    }
    if (peak * limiterGain > LIMIT) limiterGain = LIMIT / peak;

    const mixed = Buffer.alloc(FRAME_16K);
    for (let i = 0; i < samples; i++) {
      mixed.writeInt16LE(Math.round(sums[i] * limiterGain), i * 2);
    }
    mgr.sendAudioChunk(mixed, true);
  }, 20);

  const guildId = connection.joinConfig.guildId;

  connection.on('stateChange', (_, newState) => {
    if (newState.status === 'destroyed') {
      sessions.delete(guildId);
      clearInterval(mixTimer);
      stopPlayback();
      mgr.stop();
      tap?.close();
    }
  });

  // Гонка двух /join: пока мы ждали открытия Gemini-сессии, конкурирующий joinChannel
  // мог снести это соединение — событие destroyed выстрелило ДО навешивания обработчика
  // выше, и никто бы не погасил сессию (зомби у Google + вечный таймер тишины).
  if (connection.state.status === 'destroyed') {
    clearInterval(mixTimer);
    stopPlayback();
    mgr.stop();
    throw new Error('соединение уничтожено во время открытия сессии (параллельный /join?)');
  }

  sessions.set(guildId, mgr);
  return mgr;
}
