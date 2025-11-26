export class VertexAIClient {
    private static readonly LAMBDA_AUTH_URL = 'https://cgwuuuckpa.execute-api.ap-south-1.amazonaws.com/default/auth-lambad'
    private static readonly MODEL = 'projects/x-micron-469410-g7/locations/global/publishers/google/models/gemini-2.0-flash-live-preview-04-09'

    private ws: WebSocket | null = null
    private isConnected = false
    private resolveResponse: ((text: string) => void) | null = null
    private rejectResponse: ((error: Error) => void) | null = null
    private accumulatedText = ''

    async connect(systemInstruction: string): Promise<void> {
        if (this.isConnected && this.ws) return

        console.log('🌐 VertexAIClient: Getting token...')
        const token = await this.getVertexAIToken()
        console.log('🌐 VertexAIClient: Connecting to WebSocket...')
        const url = `wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent?access_token=${encodeURIComponent(token)}`

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(url)

            this.ws.addEventListener('open', () => {
                console.log('🌐 VertexAIClient: Connected. Sending setup...')
                this.isConnected = true

                // Send setup
                const setupMessage = {
                    setup: {
                        model: VertexAIClient.MODEL,
                        generationConfig: { responseModalities: ['TEXT'] },
                        systemInstruction: { parts: [{ text: systemInstruction }] }
                    }
                }
                this.ws?.send(JSON.stringify(setupMessage))
                resolve()
            })

            this.ws.addEventListener('message', (event) => {
                this.handleMessage(event)
            })

            this.ws.addEventListener('error', (e) => {
                console.error('🌐 VertexAIClient: WebSocket error:', e)
                this.isConnected = false
                if (this.rejectResponse) {
                    this.rejectResponse(new Error('WebSocket error'))
                    this.rejectResponse = null
                }
                reject(e)
            })

            this.ws.addEventListener('close', () => {
                console.log('🌐 VertexAIClient: WebSocket closed')
                this.isConnected = false
                this.ws = null
            })
        })
    }

    async send(prompt: string): Promise<string> {
        if (!this.isConnected || !this.ws) {
            throw new Error('VertexAIClient is not connected')
        }

        return new Promise((resolve, reject) => {
            this.resolveResponse = resolve
            this.rejectResponse = reject
            this.accumulatedText = ''

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
                        this.accumulatedText += part.text
                    }
                }
            }

            if (response.serverContent?.turnComplete) {
                console.log('🌐 VertexAIClient: Turn complete.')
                if (this.resolveResponse) {
                    this.resolveResponse(this.accumulatedText)
                    this.resolveResponse = null
                    this.rejectResponse = null
                }
            }

            if (response.error) {
                console.error('🌐 VertexAIClient: Error response:', response.error)
                if (this.rejectResponse) {
                    this.rejectResponse(new Error(response.error.message))
                    this.resolveResponse = null
                    this.rejectResponse = null
                }
            }
        } catch (e) {
            console.error('🌐 VertexAIClient: Parse error:', e)
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close()
            this.ws = null
            this.isConnected = false
        }
    }

    private async getVertexAIToken(): Promise<string> {
        const response = await fetch(VertexAIClient.LAMBDA_AUTH_URL)
        const data = await response.json() as any
        return data.auth?.access_token || data.access_token
    }
}
