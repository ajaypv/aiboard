export interface FunctionDeclaration {
    name: string
    description?: string
    parameters?: any
}

export interface Tool {
    functionDeclarations: FunctionDeclaration[]
}

export interface VertexAIConfig {
    model?: string
    systemInstruction?: string
    tools?: Tool[]
    generationConfig?: {
        responseModalities?: ('TEXT' | 'AUDIO' | 'IMAGE')[]
        temperature?: number
        maxOutputTokens?: number
        topP?: number
        topK?: number
    }
}

export type VertexAIEvent =
    | { type: 'content', text: string }
    | { type: 'tool_call', functionCall: { name: string, args: any } }
    | { type: 'turn_complete' }
    | { type: 'error', error: Error }
    | { type: 'interrupted' }

export class VertexAIClient {
    private static readonly LAMBDA_AUTH_URL = 'https://cgwuuuckpa.execute-api.ap-south-1.amazonaws.com/default/auth-lambad'
    private static readonly DEFAULT_MODEL = 'projects/openodts/locations/global/publishers/google/models/gemini-2.0-flash-live-preview-04-09'

    private ws: WebSocket | null = null
    private isConnected = false
    private config: VertexAIConfig | null = null

    // Event handlers
    private onEvent: ((event: VertexAIEvent) => void) | null = null

    constructor(config?: VertexAIConfig) {
        this.config = config || null
    }

    async connect(config?: VertexAIConfig): Promise<void> {
        if (this.isConnected && this.ws) return

        if (config) {
            this.config = { ...this.config, ...config }
        }

        console.log('🌐 VertexAIClient: Getting token...')
        const token = await this.getVertexAIToken()
        console.log('🌐 VertexAIClient: Connecting to WebSocket...')
        const url = `wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent?access_token=${encodeURIComponent(token)}`

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(url)

            this.ws.addEventListener('open', () => {
                console.log('🌐 VertexAIClient: Connected. Sending setup...')
                this.isConnected = true
                this.sendSetupMessage()
                resolve()
            })

            this.ws.addEventListener('message', (event) => {
                this.handleMessage(event)
            })

            this.ws.addEventListener('error', (e) => {
                console.error('🌐 VertexAIClient: WebSocket error:', e)
                this.isConnected = false
                this.emit({ type: 'error', error: new Error('WebSocket error') })
                reject(e)
            })

            this.ws.addEventListener('close', () => {
                console.log('🌐 VertexAIClient: WebSocket closed')
                this.isConnected = false
                this.ws = null
            })
        })
    }

    private sendSetupMessage() {
        if (!this.ws || !this.config) return

        const setupMessage = {
            setup: {
                model: this.config.model || VertexAIClient.DEFAULT_MODEL,
                generationConfig: this.config.generationConfig || { responseModalities: ['TEXT'] },
                systemInstruction: this.config.systemInstruction ? { parts: [{ text: this.config.systemInstruction }] } : undefined,
                tools: this.config.tools
            }
        }
        this.ws.send(JSON.stringify(setupMessage))
    }

    async send(prompt: string): Promise<string> {
        if (!this.isConnected || !this.ws) {
            throw new Error('VertexAIClient is not connected')
        }

        return new Promise((resolve, reject) => {
            let accumulatedText = ''

            const handler = (event: VertexAIEvent) => {
                if (event.type === 'content') {
                    accumulatedText += event.text
                } else if (event.type === 'turn_complete') {
                    this.onEvent = null // Clear handler
                    resolve(accumulatedText)
                } else if (event.type === 'error') {
                    this.onEvent = null
                    reject(event.error)
                }
            }

            this.onEvent = handler

            console.log('🌐 VertexAIClient: Sending prompt...')
            const userMessage = {
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text: prompt }] }],
                    turnComplete: true
                }
            }
            this.ws?.send(JSON.stringify(userMessage))
        })
    }

    /**
     * Send a tool response back to the model
     */
    async sendToolResponse(functionResponses: { name: string, response: any }[]) {
        if (!this.isConnected || !this.ws) {
            throw new Error('VertexAIClient is not connected')
        }

        const parts = functionResponses.map(fr => ({
            functionResponse: {
                name: fr.name,
                response: { result: fr.response } // Wrap in result object as per Gemini API usually
            }
        }))

        const message = {
            clientContent: {
                turns: [{ role: 'user', parts }],
                turnComplete: true
            }
        }
        this.ws.send(JSON.stringify(message))
    }

    async *stream(prompt: string): AsyncGenerator<string> {
        if (!this.isConnected || !this.ws) {
            throw new Error('VertexAIClient is not connected')
        }

        console.log('🌐 VertexAIClient: Streaming prompt...')

        const queue: string[] = []
        let resolveNext: ((value: IteratorResult<string>) => void) | null = null
        let done = false
        let error: Error | null = null

        this.onEvent = (event) => {
            if (event.type === 'content') {
                if (resolveNext) {
                    resolveNext({ value: event.text, done: false })
                    resolveNext = null
                } else {
                    queue.push(event.text)
                }
            } else if (event.type === 'turn_complete') {
                done = true
                if (resolveNext) {
                    resolveNext({ value: undefined, done: true })
                    resolveNext = null
                }
            } else if (event.type === 'error') {
                error = event.error
                if (resolveNext) {
                    resolveNext({ value: undefined, done: true }) // Or throw
                    resolveNext = null
                }
            }
        }

        const userMessage = {
            clientContent: {
                turns: [{ role: 'user', parts: [{ text: prompt }] }],
                turnComplete: true
            }
        }
        this.ws.send(JSON.stringify(userMessage))

        try {
            while (true) {
                if (error) throw error
                if (queue.length > 0) {
                    yield queue.shift()!
                    continue
                }
                if (done) break

                const result = await new Promise<IteratorResult<string>>((resolve) => {
                    resolveNext = resolve
                })

                if (result.done) break
                yield result.value
            }
        } finally {
            this.onEvent = null
        }
    }

    // Advanced usage: Subscribe to all events (content, tool calls, etc.)
    subscribe(callback: (event: VertexAIEvent) => void) {
        this.onEvent = callback
    }

    private emit(event: VertexAIEvent) {
        if (this.onEvent) {
            this.onEvent(event)
        }
    }

    private handleMessage(event: MessageEvent) {
        try {
            let jsonString: string
            if (event.data instanceof ArrayBuffer) {
                jsonString = new TextDecoder().decode(event.data)
            } else {
                jsonString = event.data as string
            }

            const response = JSON.parse(jsonString)

            if (response.serverContent?.modelTurn?.parts) {
                for (const part of response.serverContent.modelTurn.parts) {
                    if (part.text) {
                        this.emit({ type: 'content', text: part.text })
                    }
                    if (part.functionCall) {
                        this.emit({ type: 'tool_call', functionCall: part.functionCall })
                    }
                }
            }

            if (response.serverContent?.turnComplete) {
                console.log('🌐 VertexAIClient: Turn complete.')
                this.emit({ type: 'turn_complete' })
            }

            if (response.serverContent?.interrupted) {
                console.log('🌐 VertexAIClient: Interrupted.')
                this.emit({ type: 'interrupted' })
            }

            if (response.error) {
                console.error('🌐 VertexAIClient: Error response:', response.error)
                this.emit({ type: 'error', error: new Error(response.error.message) })
            }
        } catch (e: any) {
            console.error('🌐 VertexAIClient: Parse error:', e)
            this.emit({ type: 'error', error: e })
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close()
            this.ws = null
            this.isConnected = false
            this.onEvent = null
        }
    }

    private static cachedToken: string | null = null
    private static tokenExpiry: number = 0

    async getVertexAIToken(): Promise<string> {
        const now = Date.now()
        if (VertexAIClient.cachedToken && now < VertexAIClient.tokenExpiry) {
            console.log('🌐 VertexAIClient: Using cached token')
            return VertexAIClient.cachedToken
        }

        console.log('🌐 VertexAIClient: Fetching new token...')
        try {
            const response = await fetch(VertexAIClient.LAMBDA_AUTH_URL)
            const data = await response.json() as any
            const token = data.auth?.access_token || data.access_token

            if (token) {
                VertexAIClient.cachedToken = token
                VertexAIClient.tokenExpiry = now + 9 * 60 * 1000
            }
            return token
        } catch (e) {
            console.error('Failed to fetch token:', e)
            throw e
        }
    }
}
