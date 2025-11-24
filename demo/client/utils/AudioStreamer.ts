export class AudioStreamer {
    private audioContext: AudioContext | null = null
    private mediaStream: MediaStream | null = null
    private processor: ScriptProcessorNode | null = null
    private source: MediaStreamAudioSourceNode | null = null
    private isRecording = false
    private onDataCallback: ((data: string) => void) | null = null
    private nextStartTime = 0

    constructor() {
        // Initialize AudioContext lazily to comply with browser autoplay policies
    }

    async initialize() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
                sampleRate: 24000, // Try to set sample rate to 24kHz
            })
            console.log('AudioStreamer: AudioContext initialized, sampleRate:', this.audioContext.sampleRate)
        }

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume()
        }
    }

    async startRecording(onData: (data: string) => void) {
        console.log('AudioStreamer: startRecording called')
        await this.initialize()
        if (!this.audioContext) {
            console.error('AudioStreamer: AudioContext not initialized')
            return
        }

        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 24000,
                },
            })
            console.log('AudioStreamer: Microphone access granted')

            this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
            // Use ScriptProcessor for wider compatibility, though AudioWorklet is preferred in modern browsers
            // Buffer size 4096 provides a good balance between latency and performance
            this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)

            this.onDataCallback = onData
            this.isRecording = true

            this.processor.onaudioprocess = (e) => {
                if (!this.isRecording) return

                const inputData = e.inputBuffer.getChannelData(0)
                // console.log('AudioStreamer: Processing audio chunk, size:', inputData.length)

                // Check for silence
                let maxVal = 0;
                for (let i = 0; i < inputData.length; i++) {
                    const val = Math.abs(inputData[i]);
                    if (val > maxVal) maxVal = val;
                }
                if (maxVal < 0.01) {
                    // console.log('AudioStreamer: Silence detected, max level:', maxVal);
                } else {
                    console.log('AudioStreamer: Audio detected, max level:', maxVal);
                }

                const pcmData = this.floatTo16BitPCM(inputData)
                const base64Data = this.arrayBufferToBase64(pcmData)

                if (this.onDataCallback) {
                    this.onDataCallback(base64Data)
                }
            }

            this.source.connect(this.processor)
            this.processor.connect(this.audioContext.destination)
            console.log('AudioStreamer: Recording started')
        } catch (error) {
            console.error('Error starting recording:', error)
            throw error
        }
    }

    stopRecording() {
        this.isRecording = false
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop())
            this.mediaStream = null
        }
        if (this.processor && this.source) {
            this.source.disconnect()
            this.processor.disconnect()
            this.processor = null
            this.source = null
        }
    }

    async playAudio(base64Data: string) {
        await this.initialize()
        if (!this.audioContext) return

        try {
            const arrayBuffer = this.base64ToArrayBuffer(base64Data)
            // Create a buffer with the raw PCM data
            // We know it's 24kHz 16-bit PCM mono
            const int16Array = new Int16Array(arrayBuffer)
            const float32Array = new Float32Array(int16Array.length)

            for (let i = 0; i < int16Array.length; i++) {
                float32Array[i] = int16Array[i] / 32768
            }

            const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, 24000)
            audioBuffer.copyToChannel(float32Array, 0)

            const source = this.audioContext.createBufferSource()
            source.buffer = audioBuffer
            source.connect(this.audioContext.destination)

            // Schedule playback
            const currentTime = this.audioContext.currentTime
            // Ensure we don't schedule in the past
            const startTime = Math.max(currentTime, this.nextStartTime)
            source.start(startTime)

            // Update next start time
            this.nextStartTime = startTime + audioBuffer.duration
        } catch (error) {
            console.error('Error playing audio:', error)
        }
    }

    private floatTo16BitPCM(input: Float32Array): ArrayBuffer {
        const output = new Int16Array(input.length)
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]))
            output[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        return output.buffer
    }

    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = ''
        const bytes = new Uint8Array(buffer)
        const len = bytes.byteLength
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i])
        }
        return window.btoa(binary)
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binaryString = window.atob(base64)
        const len = binaryString.length
        const bytes = new Uint8Array(len)
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i)
        }
        return bytes.buffer
    }
}
