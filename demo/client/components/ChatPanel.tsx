import { FormEventHandler, useCallback, useEffect, useRef, useState } from 'react'
import { useValue } from 'tldraw'
import { convertTldrawShapeToSimpleShape } from '../../shared/format/convertTldrawShapeToSimpleShape'
import { TldrawAgent } from '../agent/TldrawAgent'
import { ChatHistory } from './chat-history/ChatHistory'
import { ChatInput } from './ChatInput'
import { TodoList } from './TodoList'

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

	// Audio WebSocket
	const audioWsRef = useRef<WebSocket | null>(null)
	const handleSendMessageRef = useRef(handleSendMessage)
	const isAutoSendRef = useRef(isAutoSend)

	useEffect(() => {
		handleSendMessageRef.current = handleSendMessage
		isAutoSendRef.current = isAutoSend
	}, [handleSendMessage, isAutoSend])

	useEffect(() => {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
		const host = window.location.host
		const wsUrl = `${protocol}//${host}/voice`

		const ws = new WebSocket(wsUrl)
		audioWsRef.current = ws

		ws.onopen = () => {
			console.log('Connected to Voice WebSocket')
		}

		ws.onmessage = async (event) => {
			const data = JSON.parse(event.data)
			if (data.type === 'text') {
				console.log('Received text:', data.text)
				// Auto-send the text if enabled
				if (handleSendMessageRef.current && isAutoSendRef.current) {
					handleSendMessageRef.current(data.text)
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
				<button
					className="auto-send-toggle"
					onClick={() => setIsAutoSend(!isAutoSend)}
					title={isAutoSend ? "Auto-send enabled" : "Auto-send disabled"}
					style={{ marginLeft: 'auto', marginRight: '10px', background: 'none', border: 'none', cursor: 'pointer', opacity: isAutoSend ? 1 : 0.5 }}
				>
					{isAutoSend ? '⚡' : '🖐️'}
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
