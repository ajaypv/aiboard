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

	const handleSubmit = useCallback<FormEventHandler<HTMLFormElement>>(
		async (e) => {
			e.preventDefault()
			if (!inputRef.current) return
			const formData = new FormData(e.currentTarget)
			const value = formData.get('input') as string

			// If the user's message is empty, just cancel the current request (if there is one)
			if (value === '') {
				agent.cancel()
				return
			}

			// If every todo is done, clear the todo list
			const todosRemaining = agent.$todoList.get().filter((item) => item.status !== 'done')
			if (todosRemaining.length === 0) {
				agent.$todoList.set([])
			}

			// Grab the user query and clear the chat input
			const message = value
			const contextItems = agent.$contextItems.get()
			agent.$contextItems.set([])
			inputRef.current.value = ''
			setInputValue('') // Clear the state-managed input value as well

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

	// Audio WebSocket
	const audioWsRef = useRef<WebSocket | null>(null)

	useEffect(() => {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
		const host = window.location.host
		// Assuming the worker is serving the frontend or we know the worker URL. 
		// For dev, it might be different ports. 
		// Let's assume relative path works if served from same origin, or use env var.
		// For this demo, we'll try to connect to the same host/port but with /voice
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
				setInputValue(prev => prev ? prev + ' ' + data.text : data.text)
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
