import React from 'react'
import { useLiveMode } from './useLiveMode'

/**
 * Example Live Mode Button Component
 * 
 * This component demonstrates how to use the LiveMode functionality
 * in your tldraw application.
 */
export function LiveModeButton() {
    const {
        isRecording,
        isConnected,
        startRecording,
        stopRecording,
        connect
    } = useLiveMode({
        onAction: (action) => {
            console.log('Received action from LinterAgent:', action)
            // TODO: Apply action to tldraw editor
            // editor.createShape(action.shape)
            // editor.updateShape(action.shape)
            // etc.
        },
        onError: (error) => {
            console.error('Live Mode error:', error)
            alert(`Live Mode Error: ${error}`)
        }
    })

    const handleClick = async () => {
        if (!isConnected) {
            try {
                await connect()
                await startRecording()
            } catch (error) {
                console.error('Failed to start live mode:', error)
            }
        } else if (isRecording) {
            stopRecording()
        } else {
            await startRecording()
        }
    }

    return (
        <button
            onClick={handleClick}
            style={{
                padding: '12px 24px',
                fontSize: '16px',
                fontWeight: 600,
                borderRadius: '8px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: isRecording ? '#ef4444' : '#3b82f6',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }}
        >
            {/* Microphone Icon */}
            <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>

            {/* Button Text */}
            <span>
                {!isConnected ? 'Connect Live Mode' : isRecording ? 'Stop Recording' : 'Start Recording'}
            </span>

            {/* Recording Indicator */}
            {isRecording && (
                <span
                    style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: 'white',
                        animation: 'pulse 1.5s infinite'
                    }}
                />
            )}
        </button>
    )
}

// Add pulse animation to the document if not already present
if (typeof document !== 'undefined') {
    const style = document.createElement('style')
    style.textContent = `
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    `
    document.head.appendChild(style)
}
