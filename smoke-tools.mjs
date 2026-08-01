import { GoogleGenAI, Modality, StartSensitivity } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } });

let called = null;
const session = await ai.live.connect({
  model: 'gemini-3.1-flash-live-preview',
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: 'Ты Ханами, девчонка в дискорде. Если просят сменить голос — вызывай инструмент.',
    proactivity: { proactiveAudio: true },
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
        prefixPaddingMs: 100,
      },
    },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: {},
    tools: [{
      functionDeclarations: [{
        name: 'set_voice',
        description: 'Сменить голос бота на указанный',
        parameters: {
          type: 'OBJECT',
          properties: { voice: { type: 'STRING', description: 'Имя голоса, например Kore' } },
          required: ['voice'],
        },
      }],
    }],
  },
  callbacks: {
    onopen: () => console.log('OPEN'),
    onmessage: (msg) => {
      if (msg.setupComplete) console.log('setupComplete: tools + proactivity приняты вместе');
      if (msg.toolCall) {
        called = msg.toolCall.functionCalls;
        console.log('TOOL CALL:', JSON.stringify(called));
        session.sendToolResponse({
          functionResponses: called.map((fc) => ({
            id: fc.id, name: fc.name, response: { result: 'ok, голос сменён' },
          })),
        });
      }
      if (msg.serverContent?.turnComplete) {
        console.log(called ? 'РЕЗУЛЬТАТ: tool calling РАБОТАЕТ' : 'turnComplete без tool call');
        session.close();
        setTimeout(() => process.exit(called ? 0 : 1), 300);
      }
    },
    onerror: (e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); },
    onclose: (e) => { if (e?.code && e.code !== 1000) { console.log('CLOSE:', e.code, e.reason); process.exit(1); } },
  },
});
session.sendClientContent({
  turns: [{ role: 'user', parts: [{ text: 'Ханами, смени голос на Kore' }] }],
  turnComplete: true,
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 20000);
