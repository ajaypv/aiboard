import { Editor, createShapeId } from 'tldraw'

export class WhiteboardAiService {
    private ws: WebSocket | null = null;
    private editor: Editor | null = null;
    private audioContext: AudioContext | null = null;
    private mediaStream: MediaStream | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private isConnected = false;

    constructor() { }

    setEditor(editor: Editor) {
        this.editor = editor;
    }

    async connect() {
        if (this.isConnected) return;

        try {
            // Replace with your actual worker URL
            this.ws = new WebSocket('wss://296bggpm-8787.inc1.devtunnels.ms/');

            this.ws.onopen = () => {
                console.log('Connected to AI Worker');
                this.isConnected = true;
            };

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            };

            this.ws.onclose = () => {
                console.log('Disconnected from AI Worker');
                this.isConnected = false;
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };

        } catch (error) {
            console.error('Failed to connect:', error);
        }
    }

    async startAudio() {
        if (!this.isConnected) await this.connect();

        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 24000,
                }
            });

            this.audioContext = new AudioContext({ sampleRate: 24000 });
            this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

            // Use 2048 buffer size like aiService.ts might imply or standard practice for 24kHz
            this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);

            this.source.connect(this.processor);
            this.processor.connect(this.audioContext.destination);

            this.processor.onaudioprocess = (e) => {
                if (!this.isConnected || !this.ws) return;

                const inputData = e.inputBuffer.getChannelData(0);

                // Convert float32 to int16 (PCM)
                const pcmData = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Convert to base64
                let binary = '';
                const bytes = new Uint8Array(pcmData.buffer);
                const len = bytes.byteLength;
                for (let i = 0; i < len; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const base64Data = btoa(binary);

                this.ws.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm",
                            data: base64Data
                        }]
                    }
                }));
            };

        } catch (error) {
            console.error('Error starting audio:', error);
        }
    }

    stopAudio() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        if (this.source) {
            this.source.disconnect();
            this.source = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    private handleMessage(data: any) {
        if (data.type === 'drawing_commands') {
            this.executeDrawingCommands(data.commands);
        } else if (data.type === 'text_response') {
            console.log('AI Text:', data.text);
            // Optionally display text response in UI
        } else if (data.type === 'audio_data') {
            this.playAudioResponse(data.data);
        }
    }

    private executeDrawingCommands(commands: any[]) {
        if (!this.editor) return;

        // Cast to any to avoid strict type checking for batch method if types are mismatching
        (this.editor as any).batch(() => {
            commands.forEach(cmd => {
                if (cmd.type === 'create_shape') {
                    const id = createShapeId();
                    this.editor!.createShape({
                        id,
                        type: cmd.shape_type || 'geo',
                        x: cmd.x || 0,
                        y: cmd.y || 0,
                        props: cmd.props || {}
                    });
                } else if (cmd.type === 'create_text') {
                    const id = createShapeId();
                    this.editor!.createShape({
                        id,
                        type: 'text',
                        x: cmd.x || 0,
                        y: cmd.y || 0,
                        props: { text: cmd.text }
                    });
                } else if (cmd.type === 'create_arrow') {
                    const id = createShapeId();
                    this.editor!.createShape({
                        id,
                        type: 'arrow',
                        x: 0,
                        y: 0,
                        props: {
                            start: cmd.start,
                            end: cmd.end
                        }
                    });
                }
            });
        });
    }

    private audioQueue: string[] = [];
    private isPlaying = false;
    private nextStartTime = 0;

    private async playAudioResponse(base64Data: string) {
        this.audioQueue.push(base64Data);
        this.processAudioQueue();
    }

    private async processAudioQueue() {
        if (this.isPlaying || this.audioQueue.length === 0) return;

        this.isPlaying = true;

        try {
            if (!this.audioContext) {
                this.audioContext = new AudioContext({ sampleRate: 24000 });
            }

            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            while (this.audioQueue.length > 0) {
                const base64Data = this.audioQueue.shift();
                if (!base64Data) continue;

                const binaryString = atob(base64Data);
                const len = binaryString.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                const int16Array = new Int16Array(bytes.buffer);
                const float32Array = new Float32Array(int16Array.length);
                for (let i = 0; i < int16Array.length; i++) {
                    float32Array[i] = int16Array[i] / 32768.0;
                }

                const buffer = this.audioContext.createBuffer(1, float32Array.length, 24000);
                buffer.getChannelData(0).set(float32Array);

                const source = this.audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(this.audioContext.destination);

                const startTime = Math.max(this.audioContext.currentTime, this.nextStartTime);
                source.start(startTime);
                this.nextStartTime = startTime + buffer.duration;
            }

        } catch (e) {
            console.error("Error playing audio response", e);
        } finally {
            this.isPlaying = false;
        }
    }
}

export const whiteboardAiService = new WhiteboardAiService();
