import { Agent } from 'agents'
import { Environment } from '../environment'
import { VertexAIClient } from '../utils/VertexAIClient'
import { getSystemPrompt } from '../../shared/parts/SystemPromptPartUtil'

interface LinterState {
    isListening: boolean
}

export class LinterAgent extends Agent<Environment, LinterState> {
    private client: VertexAIClient | null = null

    override initialState: LinterState = {
        isListening: false
    }

    private async ensureConnected() {
        if (this.client) return

        console.log('🎙️ LinterAgent: Initializing Vertex AI connection...')
        this.client = new VertexAIClient()

        const baseSystemPrompt = getSystemPrompt()
        const systemPrompt = `
        ${baseSystemPrompt}

        ---
        ROLE: VOICE COMMAND INTERPRETER

        You are listening to the user's voice input and converting it into canvas actions.
        
        Your job is to:
        1. Listen to the user's voice commands
        2. Understand their intent (drawing, moving, modifying shapes)
        3. Generate direct drawing commands
        
        When you understand a command, use the "draw" tool to execute it immediately.
        
        Example commands:
        - "Draw a blue box" → draw({ commands: [{ type: "create", shape: { type: "geo", ... }}] })
        - "Move it to the right" → draw({ commands: [{ type: "move", ... }] })
        - "Connect the box to the circle" → draw({ commands: [{ type: "create", shape: { type: "arrow", ... }}] })
        
        Be conversational and confirm actions briefly.
        `

        try {
            await this.client.connect({
                systemInstruction: systemPrompt,
                tools: [{
                    functionDeclarations: [{
                        name: 'draw',
                        description: 'Execute drawing commands on the canvas',
                        parameters: {
                            type: 'object',
                            properties: {
                                commands: {
                                    type: 'array',
                                    description: 'Array of drawing commands',
                                    items: { type: 'object' }
                                }
                            },
                            required: ['commands']
                        }
                    }]
                }],
                generationConfig: {
                    responseModalities: ['AUDIO', 'TEXT'],
                }
            })

            // Subscribe to events
            this.client.subscribe((event) => {
                if (event.type === 'tool_call') {
                    const { name, args } = event.functionCall
                    console.log('🎙️ LinterAgent: Tool call received:', name, args)

                    if (name === 'draw') {
                        console.log('🎙️ LinterAgent: Draw commands:', JSON.stringify(args.commands))
                        // Send success response
                        this.client?.sendToolResponse([{ name, response: { result: 'Commands executed' } }])
                    }
                } else if (event.type === 'content') {
                    console.log('🎙️ LinterAgent: Text response:', event.text)
                }
            })

            console.log('🎙️ LinterAgent: Connected successfully')
        } catch (error) {
            console.error('🎙️ LinterAgent: Connection failed:', error)
            this.client = null
            throw error
        }
    }

    async processAudio(base64Audio: string) {
        try {
            // Auto-connect if needed
            await this.ensureConnected()

            if (!this.client) {
                console.warn('🎙️ LinterAgent: Client not available')
                return
            }

            await this.client.sendRealtimeInput(base64Audio)
        } catch (error) {
            console.error('🎙️ LinterAgent: Error processing audio:', error)
        }
    }

    async cleanup() {
        if (this.client) {
            this.client.disconnect()
            this.client = null
        }
    }
}
