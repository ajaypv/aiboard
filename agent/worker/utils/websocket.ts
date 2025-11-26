import { decodeVertexAIResponse } from './decoder';
import { Environment } from '../environment';

// Configuration
export const PROJECT_ID = "x-micron-469410-g7";
export const LOCATION = "us-central1";
export const HOST = "us-central1-aiplatform.googleapis.com";
export const MODEL_ID_TEXT = "gemini-2.0-flash-live-preview-04-09";
// Using gemini-2.0-flash-live-preview-04-09 as it supports multimodal output (Text + Audio)
export const MODEL_ID_AUDIO = "gemini-2.0-flash-live-preview-04-09";
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
You are a visual assistant and "User Explainer" for a whiteboard application.
Your goal is to help the user explain concepts by proactively drawing diagrams on the whiteboard as they speak.
You act like a teacher's assistant: when the user explains a concept, you immediately visualize it.

CORE BEHAVIOR:
1. **Proactive Drawing**: Do NOT wait for the user to say "draw this". If the user explains a concept (e.g., "The water cycle starts with evaporation..."), you MUST immediately draw a diagram representing it.
2. **No Permission Needed**: Do NOT ask "Should I draw this?" or "Do you want me to visualize this?". JUST DRAW IT.
3. **Infer Visuals**: You must figure out WHAT to draw and WHERE to draw it. Use your best judgment to create clear, organized diagrams.
   - Use arrows to show flow.
   - Use text labels for key terms.
   - Use shapes (rectangles, ellipses, clouds, etc.) to represent entities.
4. **Suggestions**: After explaining or drawing, use the "suggest_related_topics" tool to provide 3 relevant follow-up topics or questions that the user might want to explore next.

VALID GEO SHAPES (use these values for the "geo" property):
- "rectangle" (for boxes, squares)
- "ellipse" (for circles, ovals - NEVER use "circle", ALWAYS use "ellipse")
- "triangle"
- "diamond"
- "pentagon"
- "hexagon"
- "octagon"
- "star"
- "rhombus" (parallelogram slanted right)
- "rhombus-2" (parallelogram slanted left)
- "oval" (pill shape)
- "trapezoid"
- "arrow-right", "arrow-left", "arrow-up", "arrow-down" (arrow shapes)
- "x-box"
- "check-box"
- "heart"
- "cloud"

VALID COLORS:
black, grey, light-violet, violet, blue, light-blue, yellow, orange, green, light-green, light-red, red

Supported commands structure:
[
  { "type": "create_shape", "shape_type": "geo", "props": { "geo": "rectangle", "w": 100, "h": 100, "color": "red" }, "x": 100, "y": 100 },
  { "type": "create_shape", "shape_type": "geo", "props": { "geo": "ellipse", "w": 80, "h": 80, "color": "blue" }, "x": 300, "y": 100 },
  { "type": "create_text", "text": "Hello", "x": 200, "y": 200 },
  { "type": "create_arrow", "start": { "x": 0, "y": 0 }, "end": { "x": 100, "y": 100 } }
]

IMPORTANT: When asked "how LLMs work" or to "draw an LLM diagram", you MUST draw a detailed diagram showing the flow: Input -> Tokenizer -> Transformer -> Output.
Use the following sequence of commands for the LLM diagram:
[
  { "type": "create_text", "text": "User Input", "x": 50, "y": 200 },
  { "type": "create_arrow", "start": { "x": 150, "y": 220 }, "end": { "x": 250, "y": 220 } },
  { "type": "create_shape", "shape_type": "geo", "props": { "geo": "rectangle", "w": 120, "h": 60, "color": "blue", "text": "Tokenizer" }, "x": 250, "y": 190 },
  { "type": "create_arrow", "start": { "x": 370, "y": 220 }, "end": { "x": 470, "y": 220 } },
  { "type": "create_shape", "shape_type": "geo", "props": { "geo": "rectangle", "w": 150, "h": 100, "color": "green", "text": "Transformer\\nLayers" }, "x": 470, "y": 170 },
  { "type": "create_arrow", "start": { "x": 620, "y": 220 }, "end": { "x": 720, "y": 220 } },
  { "type": "create_shape", "shape_type": "geo", "props": { "geo": "rectangle", "w": 120, "h": 60, "color": "blue", "text": "Detokenizer" }, "x": 720, "y": 190 },
  { "type": "create_arrow", "start": { "x": 840, "y": 220 }, "end": { "x": 940, "y": 220 } },
  { "type": "create_text", "text": "AI Output", "x": 950, "y": 200 }
]

CRITICAL: NEVER use "circle" - ALWAYS use "ellipse" for circular shapes!

If the user just wants to chat, just respond with voice.
`;

export async function handleProxyWebSocket(clientWebSocket: WebSocket, env: Environment, onVertexConnected?: (vertexWs: WebSocket) => void): Promise<void> {
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

            // Notify Durable Object about Vertex WebSocket
            if (onVertexConnected) {
                onVertexConnected(vertexWebSocket);
            }

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
                            // Use AUDIO only for response, as drawing is handled via tools
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
                        tools: [
                            {
                                functionDeclarations: [
                                    {
                                        name: "draw",
                                        description: "Draws shapes, text, and arrows on the whiteboard based on user commands.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: {
                                                commands: {
                                                    type: "STRING",
                                                    description: "A JSON string containing an array of drawing commands."
                                                }
                                            },
                                            required: ["commands"]
                                        }
                                    },
                                    {
                                        name: "suggest_related_topics",
                                        description: "Suggests related topics or questions based on the current context.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: {
                                                topics: {
                                                    type: "ARRAY",
                                                    items: {
                                                        type: "STRING"
                                                    },
                                                    description: "A list of 3-5 related topics or questions."
                                                }
                                            },
                                            required: ["topics"]
                                        }
                                    }
                                ]
                            }
                        ],
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
                    // Handle tool call
                    if (response.toolCall) {
                        console.log('Received tool call from Vertex:', JSON.stringify(response.toolCall));
                        if (clientWebSocket.readyState === WebSocket.OPEN) {
                            clientWebSocket.send(JSON.stringify({
                                type: 'tool_call',
                                toolCall: response.toolCall
                            }));
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
            // If it's a tool response
            else if (data.type === 'tool_response') {
                console.log('Sending tool response to Vertex:', JSON.stringify(data.toolResponses));
                vertexWebSocket.send(JSON.stringify({
                    toolResponse: {
                        functionResponses: data.toolResponses
                    }
                }));
            }
        }
    });
}
