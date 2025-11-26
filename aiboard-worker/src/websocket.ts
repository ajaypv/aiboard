import { decodeVertexAIResponse } from './decoder';

// Configuration
export const PROJECT_ID = "x-micron-469410-g7";
export const LOCATION = "us-central1";
export const HOST = "us-central1-aiplatform.googleapis.com";
export const MODEL_ID_TEXT = "gemini-2.0-flash-live-preview-04-09";
export const MODEL_ID_AUDIO = "gemini-live-2.5-flash-preview-native-audio-09-2025";
export const SERVICE_URL = `wss://${HOST}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
export const LAMBDA_AUTH_URL = 'https://cgwuuuckpa.execute-api.ap-south-1.amazonaws.com/default/auth-lambad';

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export function handleOptions(): Response {
    return new Response(null, {
        status: 204,
        headers: corsHeaders,
    });
}

function getModelForMode(mode: 'text' | 'audio'): string {
    const modelId = mode === 'audio' ? MODEL_ID_AUDIO : MODEL_ID_TEXT;
    return `projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}`;
}

export async function getAuthToken(userId?: string, kv?: KVNamespace): Promise<string> {
    // Simplified for this implementation - just fetch from lambda
    const authResponse = await fetch(LAMBDA_AUTH_URL);
    if (!authResponse.ok) {
        throw new Error(`Failed to get auth token: ${authResponse.status}`);
    }

    const authData = await authResponse.json() as any;
    const accessToken = authData.auth?.access_token || authData.access_token || authData.auth?.token || authData.token;

    if (!accessToken) {
        throw new Error('No access token received from Lambda');
    }

    return accessToken;
}

export function createAuthenticatedServiceUrl(accessToken: string): string {
    return `${SERVICE_URL}?access_token=${encodeURIComponent(accessToken)}`;
}

// System instruction for the whiteboard AI
const SYSTEM_INSTRUCTION = `
You are a visual assistant for a whiteboard application. 
Your goal is to help the user draw on the whiteboard based on their voice or text commands.
You can also answer questions and engage in conversation.

When the user asks to draw something, you MUST output a JSON object with a "drawing_commands" field.
The "drawing_commands" field should be an array of tldraw-compatible shape objects or simplified commands.

Supported simplified commands:
- { "type": "create_shape", "shape_type": "geo", "props": { "geo": "rectangle", "w": 100, "h": 100, "color": "red" }, "x": 100, "y": 100 }
- { "type": "create_text", "text": "Hello", "x": 200, "y": 200 }
- { "type": "create_arrow", "start": { "x": 0, "y": 0 }, "end": { "x": 100, "y": 100 } }

Example:
User: "Draw a blue circle"
Output: 
\`\`\`json
{
  "drawing_commands": [
    { "type": "create_shape", "shape_type": "geo", "props": { "geo": "ellipse", "w": 100, "h": 100, "color": "blue" }, "x": 300, "y": 300 }
  ]
}
\`\`\`

If the user just wants to chat, just respond with text.
`;

export async function handleProxyWebSocket(clientWebSocket: WebSocket, env: Env): Promise<void> {
    let vertexWebSocket: WebSocket | null = null;
    let currentMode: 'text' | 'audio' = 'audio'; // Default to audio for voice control

    console.log('✅ Starting WebSocket session');

    async function connectToVertex() {
        try {
            if (clientWebSocket.readyState === WebSocket.OPEN) {
                clientWebSocket.send(JSON.stringify({ type: 'connecting', message: 'Connecting to AI...' }));
            }

            const accessToken = await getAuthToken();
            const url = createAuthenticatedServiceUrl(accessToken);

            vertexWebSocket = new WebSocket(url);

            vertexWebSocket.addEventListener('open', () => {
                console.log('✅ Connected to Vertex AI');
                if (clientWebSocket.readyState === WebSocket.OPEN) {
                    clientWebSocket.send(JSON.stringify({ type: 'connected', message: 'Connected to AI' }));
                }

                // Send setup message
                const setupMessage: any = {
                    setup: {
                        model: getModelForMode(currentMode),
                        generationConfig: {
                            responseModalities: currentMode === 'audio' ? ["AUDIO"] : ["TEXT"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: {
                                        voiceName: "Aoede"
                                    }
                                }
                            }
                        },
                        systemInstruction: {
                            parts: [{ text: SYSTEM_INSTRUCTION }]
                        },
                        realtime_input_config: {
                            automatic_activity_detection: {
                                disabled: false,
                                start_of_speech_sensitivity: 'START_SENSITIVITY_LOW',
                                end_of_speech_sensitivity: 'END_SENSITIVITY_LOW',
                                prefix_padding_ms: 300,
                                silence_duration_ms: 800
                            }
                        }
                    }
                };

                if (currentMode === 'audio') {
                    setupMessage.setup.input_audio_transcription = {};
                    setupMessage.setup.output_audio_transcription = {};
                }
                console.log('Sending setup message:', JSON.stringify(setupMessage, null, 2));
                vertexWebSocket?.send(JSON.stringify(setupMessage));
            });

            vertexWebSocket.addEventListener('message', (event) => {
                try {
                    // Forward raw data if needed, or decode
                    const response = decodeVertexAIResponse(event.data);

                    // Handle server content
                    if (response.serverContent) {
                        const content = response.serverContent;
                        if (content.modelTurn?.parts) {
                            for (const part of content.modelTurn.parts) {
                                if (part.text) {
                                    // Check for JSON commands in text
                                    try {
                                        const jsonMatch = part.text.match(/```json\n([\s\S]*?)\n```/) || part.text.match(/{[\s\S]*}/);
                                        if (jsonMatch) {
                                            const jsonStr = jsonMatch[1] || jsonMatch[0];
                                            const data = JSON.parse(jsonStr);
                                            if (data.drawing_commands && clientWebSocket.readyState === WebSocket.OPEN) {
                                                clientWebSocket.send(JSON.stringify({
                                                    type: 'drawing_commands',
                                                    commands: data.drawing_commands
                                                }));
                                            }
                                        }
                                    } catch (e) {
                                        // Not JSON or failed to parse, treat as normal text
                                    }

                                    if (clientWebSocket.readyState === WebSocket.OPEN) {
                                        clientWebSocket.send(JSON.stringify({
                                            type: 'text_response',
                                            text: part.text
                                        }));
                                    }
                                }

                                if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                                    if (clientWebSocket.readyState === WebSocket.OPEN) {
                                        clientWebSocket.send(JSON.stringify({
                                            type: 'audio_data',
                                            data: part.inlineData.data
                                        }));
                                    }
                                }
                            }
                        }

                        if (content.turnComplete && clientWebSocket.readyState === WebSocket.OPEN) {
                            clientWebSocket.send(JSON.stringify({ type: 'turn_complete' }));
                        }
                    }
                } catch (e) {
                    console.error('Error processing message:', e);
                }
            });

            vertexWebSocket.addEventListener('error', (event) => {
                console.error('Vertex AI WebSocket Error:', event);
            });

            vertexWebSocket.addEventListener('close', (event) => {
                console.log(`Vertex AI closed. Code: ${event.code}, Reason: ${event.reason}`);
                if (clientWebSocket.readyState === WebSocket.OPEN) {
                    clientWebSocket.close();
                }
            });

        } catch (e) {
            console.error('Connection error:', e);
            if (clientWebSocket.readyState === WebSocket.OPEN) {
                clientWebSocket.send(JSON.stringify({ type: 'error', error: String(e) }));
            }
        }
    }

    await connectToVertex();

    clientWebSocket.addEventListener('message', (event) => {
        const data = JSON.parse(event.data as string);

        if (vertexWebSocket && vertexWebSocket.readyState === WebSocket.OPEN) {
            // Forward client messages to Vertex
            // If it's audio data
            if (data.realtimeInput) {
                vertexWebSocket.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm;rate=24000",
                            data: data.realtimeInput.mediaChunks[0].data
                        }]
                    }
                }));
            }
            // If it's text
            else if (data.text) {
                vertexWebSocket.send(JSON.stringify({
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: data.text }]
                        }],
                        turnComplete: true
                    }
                }));
            }
        }
    });
}
