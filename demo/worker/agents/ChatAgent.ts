import { AIChatAgent } from 'agents/ai-chat-agent'
import { Schedule } from 'agents'
import { Environment } from '../environment'
import { createUIMessageStream, createUIMessageStreamResponse, StreamTextOnFinishCallback, ToolSet, generateId } from 'ai'
import { buildSystemPrompt } from '../prompt/buildSystemPrompt'
import { VertexAIClient } from '../utils/VertexAIClient'

export class ChatAgent extends AIChatAgent<Environment> {
    override async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>, _options?: { abortSignal?: AbortSignal }) {
        const stream = createUIMessageStream({
            execute: async ({ writer }) => {
                const client = new VertexAIClient()
                try {
                    // Get the latest user message
                    const lastMessage = this.messages[this.messages.length - 1] as any
                    const userText = lastMessage.parts.find((p: any) => p.type === 'text')?.text || ''

                    // Connect to Vertex AI
                    await client.connect({
                        systemInstruction: buildSystemPrompt({ messages: [] } as any)
                    })

                    // Handle incoming messages from Vertex AI
                    let accumulatedText = ''
                    let sentActionCount = 0

                    for await (const chunk of client.stream(userText)) {
                        accumulatedText += chunk
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

                } catch (error: any) {
                    console.error('ChatAgent error:', error)
                    // @ts-ignore
                    writer.append(`Error: ${error.message}`)
                } finally {
                    client.disconnect()
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
