import { useEffect, useRef, useState } from 'react'
import { LiveModeAgent } from './LiveModeAgent'

export interface UseLiveModeOptions {
    /**
     * Custom WebSocket connection URL (optional)
     */
    connectionUrl?: string

    /**
     * Callback when canvas actions are received
     */
    onAction?: (action: any) => void

    /**
     * Callback when errors occur
     */
    onError?: (error: string) => void

    /**
     * Auto-connect on mount (default: false)
     */
    autoConnect?: boolean
}

export interface UseLiveModeReturn {
    /** Whether currently recording */
    isRecording: boolean

    /** Whether connected to the backend */
    isConnected: boolean

    /** Start recording audio */
    startRecording: () => Promise<void>

    /** Stop recording audio */
    stopRecording: () => void

    /** Connect to backend */
    connect: () => Promise<void>

    /** Disconnect from backend */
    disconnect: () => void

    /** Toggle recording on/off */
    toggleRecording: () => Promise<void>
}

/**
 * React hook for Live Mode voice interaction
 * 
 * @example
 * ```tsx
 * const { isRecording, startRecording, stopRecording } = useLiveMode({
 *   onAction: (action) => {
 *     // Apply action to canvas
 *   }
 * })
 * 
 * return (
 *   <button onClick={isRecording ? stopRecording : startRecording}>
 *     {isRecording ? 'Stop' : 'Start'} Recording
 *   </button>
 * )
 * ```
 */
export function useLiveMode(options: UseLiveModeOptions = {}): UseLiveModeReturn {
    const agentRef = useRef<LiveModeAgent | null>(null)
    const [isRecording, setIsRecording] = useState(false)
    const [isConnected, setIsConnected] = useState(false)

    // Initialize agent on mount
    useEffect(() => {
        const agent = new LiveModeAgent(options.connectionUrl)

        // Set up callbacks
        if (options.onAction) {
            agent.onAction = options.onAction
        }
        if (options.onError) {
            agent.onError = options.onError
        }

        agentRef.current = agent

        // Auto-connect if requested
        if (options.autoConnect) {
            agent.connect()
                .then(() => setIsConnected(true))
                .catch((error) => {
                    console.error('Failed to auto-connect:', error)
                    options.onError?.(error.message)
                })
        }

        // Cleanup on unmount
        return () => {
            agent.disconnect()
            agentRef.current = null
        }
    }, []) // Empty deps - only run on mount

    const connect = async () => {
        if (!agentRef.current) return
        try {
            await agentRef.current.connect()
            setIsConnected(true)
        } catch (error: any) {
            console.error('Failed to connect:', error)
            options.onError?.(error.message)
            throw error
        }
    }

    const disconnect = () => {
        if (!agentRef.current) return
        agentRef.current.disconnect()
        setIsConnected(false)
        setIsRecording(false)
    }

    const startRecording = async () => {
        if (!agentRef.current) return
        try {
            await agentRef.current.startRecording()
            setIsRecording(true)
        } catch (error: any) {
            console.error('Failed to start recording:', error)
            options.onError?.(error.message)
            throw error
        }
    }

    const stopRecording = () => {
        if (!agentRef.current) return
        agentRef.current.stopRecording()
        setIsRecording(false)
    }

    const toggleRecording = async () => {
        if (isRecording) {
            stopRecording()
        } else {
            await startRecording()
        }
    }

    return {
        isRecording,
        isConnected,
        startRecording,
        stopRecording,
        connect,
        disconnect,
        toggleRecording,
    }
}
