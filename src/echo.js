import { Readable } from 'node:stream';
import prism from 'prism-media';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  NoSubscriberBehavior,
} from '@discordjs/voice';

// Эхо-режим: слушаем каждого говорящего, после паузы проигрываем его реплику обратно.
// Цель — проверить весь аудио-тракт (приём, декод, воспроизведение) до подключения ИИ.
export function startEcho(connection) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(player);

  const receiver = connection.receiver;
  const active = new Set(); // юзеры, которых уже пишем в данный момент

  receiver.speaking.on('start', (userId) => {
    if (active.has(userId)) return;
    active.add(userId);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    // Кап на минуту звука (~11.5 МБ): эхо — диагностика, не магнитофон;
    // без лимита трёхминутная музыка в канале съедала бы десятки МБ за реплику
    const MAX_BYTES = 48000 * 4 * 60;
    let total = 0;
    const chunks = [];
    opusStream.pipe(decoder);
    decoder.on('data', (chunk) => {
      total += chunk.length;
      while (total > MAX_BYTES && chunks.length) total -= chunks.shift().length;
      chunks.push(chunk);
    });

    decoder.on('end', () => {
      active.delete(userId);
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) return;

      const seconds = (pcm.length / (48000 * 2 * 2)).toFixed(1);
      console.log(`echo: ${userId} — ${seconds}s PCM (${pcm.length} bytes)`);

      const resource = createAudioResource(Readable.from(pcm), {
        inputType: StreamType.Raw, // 48kHz stereo s16le
      });
      player.play(resource);
    });

    const onStreamError = (err) => {
      active.delete(userId);
      console.error(`receive/decode error (${userId}):`, err.message);
      opusStream.destroy();
      decoder.destroy();
    };
    opusStream.on('error', onStreamError);
    decoder.on('error', onStreamError);
  });
}
