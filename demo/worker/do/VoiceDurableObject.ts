import { DurableObject } from 'cloudflare:workers';
import { Environment } from '../environment';

export class VoiceDurableObject extends DurableObject {
    declare env: Environment;
    msgHistory: Array<Object>;
    sttModel: string;

    constructor(ctx: DurableObjectState, env: Environment) {
        super(ctx, env);
        this.env = env;
        this.msgHistory = [];
        this.sttModel = '@cf/openai/whisper-tiny-en';
    }

    override async fetch(request: Request) {
        // set up ws pipeline
        const webSocketPair = new WebSocketPair();
        const [socket, ws] = Object.values(webSocketPair);

        ws.accept();

        ws.addEventListener('message', async (event) => {
            // handle chat commands
            if (typeof event.data === 'string') {
                const { type, data, model } = JSON.parse(event.data);
                if (type === 'cmd' && data === 'clear') {
                    this.msgHistory.length = 0; // clear chat history
                } else if (type === 'config' && model) {
                    this.sttModel = model;
                    console.log('>> Switched STT model to:', this.sttModel);
                }
                return; // end processing here for this event type
            }

            // transcribe audio buffer to text (stt)
            const { text } = await this.env.AI.run(this.sttModel as any, {
                audio: [...new Uint8Array(event.data as ArrayBuffer)],
            });
            console.log('>>', text);

            // Get recent user history for context
            const recentHistory = this.msgHistory
                .filter(msg => (msg as any).role === 'user')
                .slice(-5)
                .map(msg => (msg as any).content);

            ws.send(JSON.stringify({ type: 'text', text, context: recentHistory })); // send transcription to client
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
