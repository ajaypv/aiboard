import { AIChatAgent } from 'agents/ai-chat-agent'
import { Schedule } from 'agents'
import { Environment } from '../environment'
import { createUIMessageStream, createUIMessageStreamResponse, StreamTextOnFinishCallback, ToolSet, generateId } from 'ai'
import { buildSystemPrompt } from '../prompt/buildSystemPrompt'

export class ChatAgent extends AIChatAgent<Environment> {
    override async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>, _options?: { abortSignal?: AbortSignal }) {
        const stream = createUIMessageStream({
            execute: async ({ writer }) => {
                try {
                    // Get the latest user message
                    const lastMessage = this.messages[this.messages.length - 1] as any
                    const userText = lastMessage.parts.find((p: any) => p.type === 'text')?.text || ''

                    // Get auth token for Vertex AI
                    const token = await this.getVertexAIToken()

                    // Connect to Vertex AI Live API
                    const vertexWsUrl = `wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent?access_token=${encodeURIComponent(token)}`
                    const vertexWS = new WebSocket(vertexWsUrl)

                    // Wait for connection
                    await new Promise<void>((resolve, reject) => {
                        vertexWS.addEventListener('open', () => resolve())
                        vertexWS.addEventListener('error', (e) => reject(e))
                    })

                    // Send setup message
                    const setupMessage = {
                        setup: {
                            model: 'projects/x-micron-469410-g7/locations/global/publishers/google/models/gemini-2.0-flash-live-preview-04-09',
                            generationConfig: {
                                responseModalities: ['TEXT'],
                            },
                            systemInstruction: {
                                parts: [{ text: buildSystemPrompt({ messages: [] } as any) }] // Simplified prompt data for now
                            }
                        }
                    }
                    vertexWS.send(JSON.stringify(setupMessage))

                    // Send user message
                    const userMessage = {
                        clientContent: {
                            turns: [{
                                role: 'user',
                                parts: [{ text: userText }]
                            }],
                            turnComplete: true
                        }
                    }
                    vertexWS.send(JSON.stringify(userMessage))

                    // Handle incoming messages from Vertex AI
                    let accumulatedText = ''
                    let sentActionCount = 0

                    // We need to wrap the WebSocket message handler in a promise that resolves when the turn is complete
                    await new Promise<void>((resolve, reject) => {
                        vertexWS.addEventListener('message', async (event) => {
                            try {
                                let jsonString: string
                                if (event.data instanceof ArrayBuffer) {
                                    const decoder = new TextDecoder()
                                    jsonString = decoder.decode(event.data)
                                } else {
                                    jsonString = event.data as string
                                }

                                const aiResponse = JSON.parse(jsonString)

                                if (aiResponse.serverContent?.modelTurn?.parts) {
                                    for (const part of aiResponse.serverContent.modelTurn.parts) {
                                        if (part.text) {
                                            accumulatedText += part.text
                                            // Extract and stream actions
                                            const actions = this.extractActionsFromPartialText(accumulatedText)
                                            if (actions.length > sentActionCount) {
                                                const newActions = actions.slice(sentActionCount)
                                                for (const action of newActions) {
                                                    // Ensure shapeId exists
                                                    if (action.shape && !action.shape.shapeId) {
                                                        action.shape.shapeId = 'shape'
                                                    }

                                                    // Stream action to client
                                                    // @ts-ignore
                                                    writer.append({
                                                        role: 'assistant',
                                                        content: JSON.stringify({
                                                            type: 'action',
                                                            action: { ...action, complete: true, time: 0 }
                                                        }) + '\n'
                                                    })
                                                }
                                                sentActionCount = actions.length
                                            }
                                        }
                                    }
                                }

                                if (aiResponse.serverContent?.turnComplete) {
                                    vertexWS.close()
                                    resolve()
                                }
                            } catch (e) {
                                console.error('Error processing Vertex message', e)
                            }
                        })

                        vertexWS.addEventListener('error', (e) => reject(e))
                        vertexWS.addEventListener('close', () => resolve())
                    })

                } catch (error: any) {
                    console.error('ChatAgent error:', error)
                    // @ts-ignore
                    writer.append(`Error: ${error.message}`)
                } finally {
                    // @ts-ignore
                    writer.close()
                }
            }
        })

        return createUIMessageStreamResponse({ stream })
    }

    async executeTask(description: string, _task: Schedule<string>) {
        await this.saveMessages([
            ...this.messages,
            {
                id: generateId(),
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: `Running scheduled task: ${description}`
                    }
                ],
                metadata: {
                    createdAt: new Date()
                }
            }
        ]);
    }

    private async getVertexAIToken(): Promise<string> {
        const LAMBDA_AUTH_URL = 'https://cgwuuuckpa.execute-api.ap-south-1.amazonaws.com/default/auth-lambad'
        const response = await fetch(LAMBDA_AUTH_URL)
        const authData = await response.json() as any
        return authData.auth?.access_token || authData.access_token
    }

    private extractActionsFromPartialText(text: string): any[] {
        const actions: any[] = []
        try {
            let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '')
            const arrayStart = clean.indexOf('[')
            if (arrayStart === -1) return []

            let depth = 0
            let start = -1
            let inString = false

            for (let i = arrayStart + 1; i < clean.length; i++) {
                const char = clean[i]
                if (char === '"' && clean[i - 1] !== '\\') {
                    inString = !inString
                    continue
                }
                if (inString) continue

                if (char === '{') {
                    if (depth === 0) start = i
                    depth++
                } else if (char === '}') {
                    depth--
                    if (depth === 0 && start !== -1) {
                        const jsonStr = clean.substring(start, i + 1)
                        try {
                            const action = JSON.parse(jsonStr)
                            if (action._type) actions.push(action)
                        } catch (e) { }
                        start = -1
                    }
                }
            }
        } catch (e) { }
        return actions
    }
}
