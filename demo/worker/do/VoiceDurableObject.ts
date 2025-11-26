import { DurableObject } from 'cloudflare:workers';
import { Environment } from '../environment';

export class VoiceDurableObject extends DurableObject {
    declare env: Environment;
    msgHistory: Array<{ role: string, content: string }>;
    sttModel: string;
    summary: string;

    constructor(ctx: DurableObjectState, env: Environment) {
        super(ctx, env);
        this.env = env;
        this.msgHistory = [];
        this.sttModel = '@cf/openai/whisper-tiny-en';
        this.summary = '';
    }

    async summarizeHistory() {
        if (this.msgHistory.length < 5) return;

        const messagesToSummarize = this.msgHistory.slice(0, this.msgHistory.length - 2); // Keep last 2 for immediate context
        const recentMessages = this.msgHistory.slice(this.msgHistory.length - 2);

        const textToSummarize = messagesToSummarize.map(m => `${m.role}: ${m.content}`).join('\n');
        const prompt = `Summarize the following conversation history into a concise context string for an AI agent. Capture the key user intents and current state.
        
        Previous Summary: ${this.summary}
        
        New Messages:
        ${textToSummarize}
        
        Summary:`;

        try {
            const response = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 100,
            });

            if ('response' in response) {
                this.summary = response.response || '';
                console.log('>> Updated Summary:', this.summary);
                this.msgHistory = recentMessages; // Prune history
            }
        } catch (e) {
            console.error('Error summarizing history:', e);
        }
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
                    this.summary = '';
                } else if (type === 'config' && model) {
                    this.sttModel = model;
                    console.log('>> Switched STT model to:', this.sttModel);
                }
                return; // end processing here for this event type
            }

            // transcribe audio buffer to text (stt)
            let { text } = await this.env.AI.run(this.sttModel as any, {
                audio: [...new Uint8Array(event.data as ArrayBuffer)],
            });
            console.log('>> Raw Transcription:', text);

            // 1. Filter Hallucinations (Repetitive patterns)
            // Check for repeated sequences like "Buh, Buh, Buh" or "you you you"
            const repetitionRegex = /(?:\b(\w+)\b[\s\r\n]*){5,}/i;
            if (repetitionRegex.test(text) || text.length > 500) { // Also catch unusually long hallucinations
                console.log('>> Detected potential hallucination/repetition. Attempting to clean...');
                // Simple heuristic: if it's just one word repeated many times, ignore it
                const words = text.split(/\s+/);
                const uniqueWords = new Set(words.map((w: string) => w.toLowerCase()));
                if (uniqueWords.size < words.length * 0.1) { // If < 10% unique words
                    console.log('>> Discarding hallucination.');
                    return;
                }
            }

            // 2. Grammar & Spelling Correction
            if (text.trim().length > 0) {
                try {
                    const correctionPrompt = `Correct the grammar and spelling of the following text. Preserve the original meaning and technical terms (e.g., "Next.js", "Tailwind CSS", "Supabase", "Cloudflare Workers"). Output ONLY the corrected text.
                    
                    Text: "${text}"
                    
                    Corrected Text:`;

                    const response = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
                        messages: [{ role: 'user', content: correctionPrompt }],
                        max_tokens: 256, // Limit output length
                    });

                    if ('response' in response && response.response) {
                        const corrected = response.response.trim();
                        // Sanity check: don't use if it's vastly different length (hallucination risk)
                        if (Math.abs(corrected.length - text.length) < text.length * 0.5 || corrected.length < text.length) {
                            console.log('>> Corrected Text:', corrected);
                            text = corrected;
                        }
                    }
                } catch (e) {
                    console.error('Error correcting text:', e);
                }
            }

            this.msgHistory.push({ role: 'user', content: text });

            // Trigger summarization if history grows too long
            if (this.msgHistory.length > 10) {
                // Run in background without awaiting to not block response
                this.ctx.waitUntil(this.summarizeHistory());
            }

            // Get recent user history for context
            const recentHistory = this.msgHistory
                .filter(msg => msg.role === 'user')
                .map(msg => msg.content);

            // Send summary + recent history
            const contextPayload = {
                summary: this.summary,
                recent: recentHistory
            };

            ws.send(JSON.stringify({ type: 'text', text, context: contextPayload })); // send transcription to client
        });

        ws.addEventListener('close', (cls) => {
            ws.close(cls.code, 'Durable Object is closing WebSocket');
        });

        return new Response(null, { status: 101, webSocket: socket });
    }
}
