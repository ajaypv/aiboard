import { FormEventHandler, useCallback, useEffect, useRef, useState } from 'react'
import { useValue } from 'tldraw'
import { convertTldrawShapeToSimpleShape } from '../../shared/format/convertTldrawShapeToSimpleShape'
import { TldrawAgent } from '../agent/TldrawAgent'
import { ChatHistory } from './chat-history/ChatHistory'
import { ChatInput } from './ChatInput'
import { TodoList } from './TodoList'
import { LiveModeButton } from '../agent/LiveModeButton'

export function ChatPanel({ agent }: { agent: TldrawAgent }) {
	const { editor } = agent
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const modelName = useValue(agent.$modelName)

	const handleSendMessage = useCallback(
		async (message: string) => {
			if (message === '') {
				agent.cancel()
				return
			}

			// If every todo is done, clear the todo list
			const todosRemaining = agent.$todoList.get().filter((item) => item.status !== 'done')
			if (todosRemaining.length === 0) {
				agent.$todoList.set([])
			}

			// Clear context and input
			const contextItems = agent.$contextItems.get()
			agent.$contextItems.set([])
			if (inputRef.current) inputRef.current.value = ''
			setInputValue('')

			// Prompt the agent
			const selectedShapes = editor
				.getSelectedShapes()
				.map((shape) => convertTldrawShapeToSimpleShape(editor, shape))

			await agent.prompt({
				message,
				contextItems,
				bounds: editor.getViewportPageBounds(),
				modelName,
				selectedShapes,
				type: 'user',
			})
		},
		[agent, modelName, editor]
	)

	const handleSubmit = useCallback<FormEventHandler<HTMLFormElement>>(
		async (e) => {
			e.preventDefault()
			if (!inputRef.current) return
			const formData = new FormData(e.currentTarget)
			const value = formData.get('input') as string
			await handleSendMessage(value)
		},
		[handleSendMessage]
	)

	function handleNewChat() {
		agent.reset()
		if (audioWsRef.current?.readyState === WebSocket.OPEN) {
			audioWsRef.current.send(JSON.stringify({ type: 'cmd', data: 'clear' }))
		}
	}

	function NewChatButton() {
		return (
			<button className="new-chat-button" onClick={handleNewChat}>
				+
			</button>
		)
	}

	const [inputValue, setInputValue] = useState('')
	const [isAutoSend, setIsAutoSend] = useState(true) // Default to auto-send
	const [sttModel, setSttModel] = useState('@cf/openai/whisper-tiny-en')

	// Audio WebSocket
	const audioWsRef = useRef<WebSocket | null>(null)
	const handleSendMessageRef = useRef(handleSendMessage)
	const isAutoSendRef = useRef(isAutoSend)
	const sttModelRef = useRef(sttModel)

	useEffect(() => {
		handleSendMessageRef.current = handleSendMessage
		isAutoSendRef.current = isAutoSend
		sttModelRef.current = sttModel
	}, [handleSendMessage, isAutoSend, sttModel])

	useEffect(() => {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
		const host = window.location.host
		const wsUrl = `${protocol}//${host}/voice`

		const ws = new WebSocket(wsUrl)
		audioWsRef.current = ws

		ws.onopen = () => {
			console.log('Connected to Voice WebSocket')
			// Send initial model config
			ws.send(JSON.stringify({ type: 'config', model: sttModelRef.current }))
		}

		ws.onmessage = async (event) => {
			const data = JSON.parse(event.data)
			if (data.type === 'text') {
				console.log('Received text:', data.text)

				// Construct message with context if available
				let messageToSend = data.text
				if (data.context) {
					const { summary, recent } = data.context
					const contextParts = []
					if (summary) contextParts.push(`Summary: ${summary}`)
					if (recent && recent.length > 0) contextParts.push(`Recent: ${recent.join(' ')}`)

					if (contextParts.length > 0) {
						messageToSend = `[Voice Context - ${contextParts.join(' | ')}] ${data.text}`
					}
				} else if (Array.isArray(data.context) && data.context.length > 0) {
					// Fallback for legacy array format
					const contextStr = data.context.join(' ')
					messageToSend = `[Voice Context: ${contextStr}] ${data.text}`
				}

				// Auto-send the text if enabled
				if (handleSendMessageRef.current && isAutoSendRef.current) {
					handleSendMessageRef.current(messageToSend)
				} else {
					// Otherwise just update the input
					setInputValue(prev => prev ? prev + ' ' + data.text : data.text)
				}
			} else if (data.type === 'audio') {
				console.log('Received audio')
				const { playAudioBuffer, base64ToArrBuff } = await import('../utils/audio')
				const audioBuffer = base64ToArrBuff(data.audio)
				playAudioBuffer(audioBuffer)
			}
		}

		ws.onerror = (error) => {
			console.error('Voice WebSocket error:', error)
		}

		return () => {
			ws.close()
		}
	}, [])

	// Update model when changed
	useEffect(() => {
		if (audioWsRef.current?.readyState === WebSocket.OPEN) {
			audioWsRef.current.send(JSON.stringify({ type: 'config', model: sttModel }))
		}
	}, [sttModel])

	// Implement sendAudio on the agent
	useEffect(() => {
		agent.sendAudio = (audioBuffer: ArrayBuffer) => {
			if (audioWsRef.current?.readyState === WebSocket.OPEN) {
				audioWsRef.current.send(audioBuffer)
			} else {
				console.warn('Voice WebSocket not connected')
			}
		}
	}, [agent])

	return (
		<div className="chat-panel tl-theme__dark">
			<div className="chat-header">
				<NewChatButton />
				<LiveModeButton />
				<select
					value={sttModel}
					onChange={(e) => setSttModel(e.target.value)}
					style={{ marginLeft: 'auto', marginRight: '10px', background: '#2f2f2f', color: '#fff', border: 'none', borderRadius: '4px', padding: '2px 5px', maxWidth: '100px', fontSize: '10px' }}
					title="Select Speech-to-Text Model"
				>
					<option value="@cf/openai/whisper-tiny-en">Whisper Tiny</option>
					<option value="@cf/openai/whisper">Whisper Base</option>
					<option value="@cf/openai/whisper-large-v3-turbo">Whisper Large v3 Turbo</option>
					{/* Adding Deepgram option as requested, though it might fail if not supported by backend binding */}
					<option value="@cf/deepgram/flux">Deepgram Flux (Nova-3)</option>
				</select>
				<button
					className="auto-send-toggle"
					onClick={() => setIsAutoSend(!isAutoSend)}
					title={isAutoSend ? "Auto-send enabled" : "Auto-send disabled"}
					style={{ marginRight: '10px', background: 'none', border: 'none', cursor: 'pointer', opacity: isAutoSend ? 1 : 0.5 }}
				>
					{isAutoSend ? '⚡' : '🖐️'}
				</button>
				<button
					className="suggester-toggle"
					onClick={() => agent.$isSuggesterEnabled.set(!agent.$isSuggesterEnabled.get())}
					title={useValue(agent.$isSuggesterEnabled) ? "Suggester enabled" : "Suggester disabled"}
					style={{ marginRight: '10px', background: 'none', border: 'none', cursor: 'pointer', opacity: useValue(agent.$isSuggesterEnabled) ? 1 : 0.5 }}
				>
					{useValue(agent.$isSuggesterEnabled) ? '✨' : '⚪'}
				</button>
			</div>
			<ChatHistory agent={agent} />
			<div className="chat-input-container">
				<TodoList agent={agent} />
				<ChatInput
					agent={agent}
					handleSubmit={handleSubmit}
					inputRef={inputRef}
					inputValue={inputValue}
					setInputValue={setInputValue}
				/>
			</div>
		</div>
	)
}
