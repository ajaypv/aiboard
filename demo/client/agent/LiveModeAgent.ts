import { AudioStreamer } from '../utils/AudioStreamer'

/**
 * LiveModeAgent - Handles voice interaction in live mode
 * Sends audio directly to the backend LinterAgent via WebSocket
 */
export class LiveModeAgent {
    private socket: WebSocket | null = null
    private audioStreamer: AudioStreamer
    private isRecording = false
    private connectionUrl: string

    constructor(connectionUrl?: string) {
        this.audioStreamer = new AudioStreamer()
        this.connectionUrl = connectionUrl || this.getDefaultConnectionUrl()
    }

    private getDefaultConnectionUrl(): string {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const host = window.location.host
        return `${protocol}//${host}/live`
    }

    /**
     * Connect to the backend WebSocket
     */
    async connect(): Promise<void> {
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
            console.log('🎙️ LiveModeAgent: Already connected')
            return
        }

        console.log('🎙️ LiveModeAgent: Connecting to', this.connectionUrl)
        this.socket = new WebSocket(this.connectionUrl)

        return new Promise((resolve, reject) => {
            if (!this.socket) return reject(new Error('Socket not initialized'))

            this.socket.onopen = () => {
                console.log('🎙️ LiveModeAgent: WebSocket connected')
                resolve()
            }

            this.socket.onmessage = (event) => {
                this.handleMessage(event)
            }

            this.socket.onerror = (error) => {
                console.error('🎙️ LiveModeAgent: WebSocket error:', error)
                reject(error)
            }

            this.socket.onclose = () => {
                console.log('🎙️ LiveModeAgent: WebSocket closed')
                this.stopRecording()
            }
        })
    }

    /**
     * Start recording and streaming audio
     */
    async startRecording(): Promise<void> {
        if (this.isRecording) {
            console.log('🎙️ LiveModeAgent: Already recording')
            return
        }

        // Ensure we're connected
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            await this.connect()
        }

        console.log('🎙️ LiveModeAgent: Starting audio recording')
        this.isRecording = true

        await this.audioStreamer.startRecording((base64Audio) => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                // Send audio data message
                this.socket.send(JSON.stringify({
                    type: 'audio_data',
                    data: base64Audio,
                    sessionId: this.getSessionId()
                }))
            } else {
                console.warn('🎙️ LiveModeAgent: Socket not ready, cannot send audio')
            }
        })
    }

    /**
     * Stop recording
     */
    stopRecording(): void {
        console.log('🎙️ LiveModeAgent: Stopping audio recording')
        this.isRecording = false
        this.audioStreamer.stopRecording()
    }

    /**
     * Disconnect from the backend
     */
    disconnect(): void {
        this.stopRecording()
        if (this.socket) {
            this.socket.close()
            this.socket = null
        }
    }

    /**
     * Handle incoming WebSocket messages
     */
    private handleMessage(event: MessageEvent): void {
        try {
            const data = JSON.parse(event.data)
            console.log('🎙️ LiveModeAgent: Received message:', data.type)

            switch (data.type) {
                case 'action':
                    // Forward actions to the canvas
                    this.onAction?.(data.action)
                    break
                case 'audio_data':
                    // Play audio response from the agent
                    if (data.data) {
                        this.audioStreamer.playAudio(data.data)
                    }
                    break
                case 'error':
                    console.error('🎙️ LiveModeAgent: Server error:', data.error)
                    this.onError?.(data.error)
                    break
                default:
                    console.log('🎙️ LiveModeAgent: Unknown message type:', data.type)
            }
        } catch (error) {
            console.error('🎙️ LiveModeAgent: Error parsing message:', error)
        }
    }

    /**
     * Get or create session ID
     */
    private getSessionId(): string {
        const stored = sessionStorage.getItem('livemode_session_id')
        if (stored) return stored

        const newId = 'session-' + crypto.randomUUID()
        sessionStorage.setItem('livemode_session_id', newId)
        return newId
    }

    /**
     * Callback for canvas actions
     */
    onAction?: (action: any) => void

    /**
     * Callback for errors
     */
    onError?: (error: string) => void

    /**
     * Get current recording state
     */
    isCurrentlyRecording(): boolean {
        return this.isRecording
    }
}
