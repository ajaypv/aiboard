import { DurableObject } from 'cloudflare:workers';
import { Environment } from '../environment';

export class VoiceDurableObject extends DurableObject {
    declare env: Environment;
    msgHistory: Array<Object>;

    constructor(ctx: DurableObjectState, env: Environment) {
        super(ctx, env);
        this.env = env;
        this.msgHistory = [];
    }

    override async fetch(request: Request) {
        // set up ws pipeline
        const webSocketPair = new WebSocketPair();
        const [socket, ws] = Object.values(webSocketPair);

        ws.accept();

        ws.addEventListener('message', async (event) => {
            // handle chat commands
            if (typeof event.data === 'string') {
                const { type, data } = JSON.parse(event.data);
                if (type === 'cmd' && data === 'clear') {
                    this.msgHistory.length = 0; // clear chat history
                }
                return; // end processing here for this event type
            }

            // transcribe audio buffer to text (stt)
            const { text } = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
                audio: [...new Uint8Array(event.data as ArrayBuffer)],
            });
            console.log('>>', text);
            ws.send(JSON.stringify({ type: 'text', text })); // send transcription to client
            this.msgHistory.push({ role: 'user', content: text });

            // run inference
            // For now, we'll just echo back or use a simple response since we might not have the full agent context here
            // Or we can try to use the same model as the main agent if available

            // For this demo, let's just acknowledge
            const responseText = `You said: ${text}`;
            this.msgHistory.push({ role: 'assistant', content: responseText });

            // convert response to audio (tts)
            // const audio = await this.env.AI.run('@cf/myshell-ai/melotts', {
            //     prompt: responseText,
            //     // lang: 'es'
            // });
            // ws.send(JSON.stringify({ type: 'audio', text: responseText, audio: audio.audio }));
        });

        ws.addEventListener('close', (cls) => {
            ws.close(cls.code, 'Durable Object is closing WebSocket');
        });

        return new Response(null, { status: 101, webSocket: socket });
    }
}
