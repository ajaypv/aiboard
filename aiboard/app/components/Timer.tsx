'use client'

import { useState, useEffect, useRef } from 'react'
import { whiteboardAiService } from '../services/whiteboardAiService'

export default function Timer() {
    const [time, setTime] = useState(0)
    const [isRunning, setIsRunning] = useState(false)
    const [hasMicrophoneAccess, setHasMicrophoneAccess] = useState(false)
    const intervalRef = useRef<NodeJS.Timeout | null>(null)
    const streamRef = useRef<MediaStream | null>(null)

    useEffect(() => {
        if (isRunning) {
            intervalRef.current = setInterval(() => {
                setTime((prevTime) => prevTime + 1)
            }, 1000)
        } else {
            if (intervalRef.current) {
                clearInterval(intervalRef.current)
            }
        }

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current)
            }
        }
    }, [isRunning])

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60)
        const secs = seconds % 60
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }

    const requestMicrophoneAccess = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream
            setHasMicrophoneAccess(true)
            return true
        } catch (err) {
            console.error('Error accessing microphone:', err)
            setHasMicrophoneAccess(false)
            return false
        }
    }

    const stopMicrophone = () => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop())
            streamRef.current = null
            setHasMicrophoneAccess(false)
        }
    }

    const toggleTimer = async () => {
        if (!isRunning) {
            const granted = await requestMicrophoneAccess()
            if (granted) {
                setIsRunning(true)
                whiteboardAiService.startAudio()
            } else {
                alert('Microphone access is required to start the session.')
            }
        } else {
            setIsRunning(false)
            stopMicrophone()
            whiteboardAiService.stopAudio()
        }
    }

    const resetTimer = () => {
        setIsRunning(false)
        stopMicrophone()
        whiteboardAiService.stopAudio()
        setTime(0)
    }

    return (
        <div className="flex items-center gap-2 rounded-full bg-gray-50 px-1 py-1 border border-gray-200 shadow-sm">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full transition-colors ${isRunning ? 'bg-red-50 text-red-600' : 'bg-transparent text-gray-600'}`}>
                <div className={`h-2 w-2 rounded-full ${isRunning ? 'bg-red-500 animate-pulse' : 'bg-gray-400'}`}></div>
                <span className="font-mono text-sm font-medium w-[4ch] text-center">{formatTime(time)}</span>
            </div>

            {hasMicrophoneAccess && (
                <div className="flex items-center justify-center w-6 h-6 text-red-500 animate-pulse" title="Microphone Active">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" x2="12" y1="19" y2="23" />
                        <line x1="8" x2="16" y1="23" y2="23" />
                    </svg>
                </div>
            )}

            <div className="flex items-center pr-1">
                <button
                    onClick={toggleTimer}
                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${isRunning
                        ? 'bg-white text-red-500 hover:bg-red-50 shadow-sm border border-gray-100'
                        : 'bg-black text-white hover:bg-gray-800'
                        }`}
                    title={isRunning ? "Stop" : "Start"}
                >
                    {isRunning ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" className="ml-0.5">
                            <path d="M5 3l14 9-14 9V3z" />
                        </svg>
                    )}
                </button>

                {time > 0 && !isRunning && (
                    <button
                        onClick={resetTimer}
                        className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        title="Reset"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    )
}
