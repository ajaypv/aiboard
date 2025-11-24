import {
	Atom,
	atom,
	Box,
	Editor,
	react,
	RecordsDiff,
	reverseRecordsDiff,
	structuredClone,
	TLRecord,
	toRichText,
	Vec,
	VecModel,
} from 'tldraw'
import { AgentActionUtil } from '../../shared/actions/AgentActionUtil'
import { AgentHelpers } from '../../shared/AgentHelpers'
import { getAgentActionUtilsRecord, getPromptPartUtilsRecord } from '../../shared/AgentUtils'
import { SimpleShape } from '../../shared/format/SimpleShape'
import { PromptPartUtil } from '../../shared/parts/PromptPartUtil'
import { AgentAction } from '../../shared/types/AgentAction'
import { AgentInput } from '../../shared/types/AgentInput'
import { AgentPrompt, BaseAgentPrompt } from '../../shared/types/AgentPrompt'
import { AgentRequest } from '../../shared/types/AgentRequest'
import { ChatHistoryItem } from '../../shared/types/ChatHistoryItem'
import {
	AreaContextItem,
	ContextItem,
	PointContextItem,
	ShapeContextItem,
	ShapesContextItem,
} from '../../shared/types/ContextItem'
import { PromptPart } from '../../shared/types/PromptPart'
import { Streaming } from '../../shared/types/Streaming'
import { TodoItem } from '../../shared/types/TodoItem'
import { AgentModelName, DEFAULT_MODEL_NAME } from '../../worker/models'
import { $agentsAtom } from './agentsAtom'
import { AudioStreamer } from '../utils/AudioStreamer'

export interface TldrawAgentOptions {
	/** The editor to associate the agent with. */
	editor: Editor
	/** A key used to differentiate the agent from other agents. */
	id: string
	/** A callback for when an error occurs. */
	onError: (e: any) => void
}

/**
 * An agent that can be prompted to edit the canvas.
 * Returned by the `useTldrawAgent` hook.
 *
 * @example
 * ```tsx
 * const agent = useTldrawAgent(editor)
 * agent.prompt({ message: 'Draw a snowman' })
 * ```
 */
export class TldrawAgent {
	/** The editor associated with this agent. */
	editor: Editor

	/** An id to differentiate the agent from other agents. */
	id: string

	/** A callback for when an error occurs. */
	onError: (e: any) => void

	/**
	 * An atom containing the currently active request.
	 * This is mainly used to render highlights and other UI elements.
	 */
	$activeRequest = atom<AgentRequest | null>('activeRequest', null)

	/**
	 * An atom containing the next request that the agent has scheduled for
	 * itself. Null if there is no scheduled request.
	 */
	$scheduledRequest = atom<AgentRequest | null>('scheduledRequest', null)

	/**
	 * An atom containing the agent's chat history.
	 */
	$chatHistory = atom<ChatHistoryItem[]>('chatHistory', [])

	/**
	 * An atom containing the position on the page where the current chat
	 * started.
	 */
	$chatOrigin = atom<VecModel>('chatOrigin', { x: 0, y: 0 })

	/**
	 * An atom containing the agent's todo list.
	 */
	$todoList = atom<TodoItem[]>('todoList', [])

	/**
	 * An atom that's used to store document changes made by the user since the
	 * previous request.
	 */
	$userActionHistory = atom<RecordsDiff<TLRecord>[]>('userActionHistory', [])

	/**
	 * An atom containing currently selected context items.
	 *
	 * To send context items to the model, include them in the `contextItems`
	 * field of a request.
	 */
	$contextItems = atom<ContextItem[]>('contextItems', [])

	/**
	 * An atom containing the model name that the user has selected. This gets
	 * passed through to prompts unless manually overridden.
	 *
	 * Note: Prompt part utils may ignore or override this value. See the
	 * ModelNamePartUtil for an example.
	 */
	/**
	 * An atom containing the model name that the user has selected. This gets
	 * passed through to prompts unless manually overridden.
	 *
	 * Note: Prompt part utils may ignore or override this value. See the
	 * ModelNamePartUtil for an example.
	 */
	$modelName = atom<AgentModelName>('modelName', DEFAULT_MODEL_NAME)

	/**
	 * An atom containing the list of suggested topics from the agent.
	 */
	$suggestions = atom<string[]>('suggestions', [])

	/**
	 * An atom that tracks whether the agent is in silent mode (no audio output).
	 */
	$isSilent = atom<boolean>('isSilent', false)

	/**
	 * Create a new tldraw agent.
	 */
	constructor({ editor, id, onError }: TldrawAgentOptions) {
		this.editor = editor
		this.id = id
		this.onError = onError

		$agentsAtom.update(editor, (agents) => [...agents, this])

		this.agentActionUtils = getAgentActionUtilsRecord(this)
		this.promptPartUtils = getPromptPartUtilsRecord(this)
		this.unknownActionUtil = this.agentActionUtils.unknown

		persistAtomInLocalStorage(this.$chatHistory, `${id}:chat-history`)
		persistAtomInLocalStorage(this.$chatOrigin, `${id}:chat-origin`)
		persistAtomInLocalStorage(this.$modelName, `${id}:model-name`)
		persistAtomInLocalStorage(this.$todoList, `${id}:todo-items`)
		persistAtomInLocalStorage(this.$contextItems, `${id}:context-items`)

		this.stopRecordingFn = this.startRecordingUserActions()
	}

	/**
	 * Dispose of the agent by cancelling requests and stopping listeners.
	 */
	dispose() {
		this.cancel()
		this.stopRecordingUserActions()
		$agentsAtom.update(this.editor, (agents) => agents.filter((agent) => agent.id !== this.id))
	}

	/**
	 * Get an agent action util for a specific action type.
	 *
	 * @param type - The type of action to get the util for.
	 * @returns The action util.
	 */
	getAgentActionUtil(type?: string) {
		const utilType = this.getAgentActionUtilType(type)
		return this.agentActionUtils[utilType]
	}

	/**
	 * Get the util type for a provided action type.
	 * If no util type is found, returns 'unknown'.
	 */
	getAgentActionUtilType(type?: string) {
		if (!type) return 'unknown'
		const util = this.agentActionUtils[type as AgentAction['_type']]
		if (!util) return 'unknown'
		return type as AgentAction['_type']
	}

	/**
	 * Get a prompt part util for a specific part type.
	 *
	 * @param type - The type of part to get the util for.
	 * @returns The part util.
	 */
	getPromptPartUtil(type: PromptPart['type']) {
		return this.promptPartUtils[type]
	}

	/**
	 * A record of the agent's action util instances.
	 * Used by the `getAgentActionUtil` method.
	 */
	agentActionUtils: Record<AgentAction['_type'], AgentActionUtil<AgentAction>>

	/**
	 * The agent action util instance for the "unknown" action type.
	 *
	 * This is returned by the `getAgentActionUtil` method when the action type
	 * isn't properly specified. This can happen if the model isn't finished
	 * streaming yet or makes a mistake.
	 */
	unknownActionUtil: AgentActionUtil<AgentAction>

	/**
	 * A record of the agent's prompt part util instances.
	 * Used by the `getPromptPartUtil` method.
	 */
	promptPartUtils: Record<PromptPart['type'], PromptPartUtil<PromptPart>>

	/**
	 * Get a full agent request from a user input by filling out any missing
	 * values with defaults.
	 * @param input - A partial agent request or a string message.
	 */
	getFullRequestFromInput(input: AgentInput): AgentRequest {
		const request = this.getPartialRequestFromInput(input)

		const activeRequest = this.$activeRequest.get()
		return {
			type: request.type ?? 'user',
			messages: request.messages ?? [],
			data: request.data ?? [],
			selectedShapes: request.selectedShapes ?? [],
			contextItems: request.contextItems ?? [],
			bounds: request.bounds ?? activeRequest?.bounds ?? this.editor.getViewportPageBounds(),
			modelName: request.modelName ?? activeRequest?.modelName ?? this.$modelName.get(),
		}
	}

	/**
	 * Convert an input into a partial request.
	 * This involves handling the various ways that the input can be provided.
	 *
	 * @example
	 * ```tsx
	 * agent.prompt('Draw a cat')
	 * agent.prompt(['Draw a cat', 'Draw a dog'])
	 * agent.prompt({ messages: 'Draw a cat' })
	 * agent.prompt({ message: 'Draw a cat' })
	 * ```
	 *
	 * @param input - The input to get the request partial from.
	 * @returns The request partial.
	 */
	private getPartialRequestFromInput(input: AgentInput): Partial<AgentRequest> {
		// eg: agent.prompt('Draw a cat')
		if (typeof input === 'string') {
			return { messages: [input] }
		}

		// eg: agent.prompt(['Draw a cat', 'Draw a dog'])
		if (Array.isArray(input)) {
			return { messages: input }
		}

		// eg: agent.prompt({ messages: 'Draw a cat' })
		if (typeof input.messages === 'string') {
			return { ...input, messages: [input.messages] }
		}

		// eg: agent.prompt({ message: 'Draw a cat' })
		if (typeof input.message === 'string') {
			return { ...input, messages: [input.message, ...(input.messages ?? [])] }
		}

		return input
	}

	/**
	 * Get a full prompt based on a request.
	 *
	 * @param request - The request to use for the prompt.
	 * @param helpers - The helpers to use.
	 * @returns The fully assembled prompt.
	 */
	async preparePrompt(request: AgentRequest, helpers: AgentHelpers): Promise<AgentPrompt> {
		const { promptPartUtils } = this
		const transformedParts: PromptPart[] = []

		for (const util of Object.values(promptPartUtils)) {
			const part = await util.getPart(structuredClone(request), helpers)
			if (!part) continue
			transformedParts.push(part)
		}

		return Object.fromEntries(transformedParts.map((part) => [part.type, part])) as AgentPrompt
	}

	/**
	 * Prompt the agent to edit the canvas.
	 *
	 * @example
	 * ```tsx
	 * const agent = useTldrawAgent(editor)
	 * agent.prompt('Draw a cat')
	 * ```
	 *
	 * ```tsx
	 * agent.prompt({
	 *   message: 'Draw a cat in this area',
	 *   bounds: {
	 *     x: 0,
	 *     y: 0,
	 *     w: 300,
	 *     h: 400,
	 *   },
	 * })
	 * ```
	 *
	 * @returns A promise for when the agent has finished its work.
	 */
	/**
	 * An atom that tracks whether the microphone is currently recording.
	 */
	$isRecording = atom<boolean>('isRecording', false)

	/**
	 * Connect to the WebSocket server.
	 */
	async connect() {
		if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
			return
		}

		this.socket = new WebSocket('ws://localhost:8787/stream')

		this.socket.onopen = () => {
			console.log('WebSocket connected')
		}

		this.socket.onmessage = async (event) => {
			const data = JSON.parse(event.data)

			if (data.type === 'audio_data') {
				if (!this.$isSilent.get()) {
					this.audioStreamer.playAudio(data.data)
				}
			} else if (data.type === 'tool_call') {
				// Handle tool calls (function calling)
				console.log('Received tool call:', data.toolCall)
				const functionCalls = data.toolCall.functionCalls
				if (functionCalls && functionCalls.length > 0) {
					const responses: any[] = []
					for (const fc of functionCalls) {
						if (fc.name === 'draw') {
							try {
								const args = fc.args
								let commands = args.commands
								if (typeof commands === 'string') {
									try {
										commands = JSON.parse(commands)
									} catch (e) {
										console.error('Failed to parse commands string:', e)
									}
								}

								if (Array.isArray(commands)) {
									console.log('Executing drawing commands from tool call:', commands)
									this.handleDrawingCommands(commands)
									responses.push({
										id: fc.id,
										name: fc.name,
										response: { result: "ok" }
									})
								} else {
									console.error('Invalid commands format in tool call:', commands)
									responses.push({
										id: fc.id,
										name: fc.name,
										response: { error: "Invalid commands format" }
									})
								}
							} catch (e) {
								console.error('Error executing draw tool:', e)
								responses.push({
									id: fc.id,
									name: fc.name,
									response: { error: String(e) }
								})
							}
						} else if (fc.name === 'suggest_related_topics') {
							try {
								const args = fc.args
								const topics = args.topics
								if (Array.isArray(topics)) {
									console.log('Received suggestions:', topics)
									this.$suggestions.set(topics)
									responses.push({
										id: fc.id,
										name: fc.name,
										response: { result: "ok" }
									})
								} else {
									console.error('Invalid topics format:', topics)
									responses.push({
										id: fc.id,
										name: fc.name,
										response: { error: "Invalid topics format" }
									})
								}
							} catch (e) {
								console.error('Error executing suggest tool:', e)
								responses.push({
									id: fc.id,
									name: fc.name,
									response: { error: String(e) }
								})
							}
						} else {
							console.warn('Unknown tool call:', fc.name)
							responses.push({
								id: fc.id,
								name: fc.name,
								response: { error: "Unknown tool" }
							})
						}
					}

					// Send tool response back to server
					if (responses.length > 0) {
						this.socket?.send(JSON.stringify({
							type: 'tool_response',
							toolResponses: responses
						}))
					}
				}
			} else if (data.type === 'drawing_commands') {
				// Legacy support for direct drawing commands (if any)
				const commands = data.commands
				console.log('Received drawing commands (legacy):', commands)
				if (Array.isArray(commands)) {
					this.handleDrawingCommands(commands)
				} else {
					console.warn('Legacy drawing commands is not an array:', commands)
				}
			} else if (data.type === 'text_response') {
				// Update chat history
				this.$chatHistory.update((prev) => {
					const lastItem = prev[prev.length - 1]
					if (lastItem && lastItem.type === 'assistant' && lastItem.isStreaming) {
						return [
							...prev.slice(0, -1),
							{ ...lastItem, text: lastItem.text + data.text }
						]
					} else {
						return [
							...prev,
							{ type: 'assistant', text: data.text, isStreaming: true }
						]
					}
				})
			} else if (data.type === 'turn_complete') {
				this.$chatHistory.update((prev) => {
					const lastItem = prev[prev.length - 1]
					if (lastItem && lastItem.type === 'assistant') {
						return [
							...prev.slice(0, -1),
							{ ...lastItem, isStreaming: false }
						]
					}
					return prev
				})
			}
		}

		this.socket.onerror = (error) => {
			console.error('WebSocket error:', error)
			this.onError(error)
		}

		this.socket.onclose = () => {
			console.log('WebSocket closed')
			this.stopAudio()
		}
	}

	async startAudio() {
		console.log('TldrawAgent: startAudio called')
		await this.connect()
		// Wait for connection...
		await new Promise<void>((resolve) => {
			if (this.socket?.readyState === WebSocket.OPEN) resolve()
			else this.socket?.addEventListener('open', () => resolve(), { once: true })
		})

		console.log('TldrawAgent: WebSocket connected, starting recording')
		this.$isRecording.set(true)
		this.audioStreamer.startRecording((data) => {
			const socket = this.socket
			const readyState = socket?.readyState
			console.log('TldrawAgent: Audio callback triggered, socket readyState:', readyState, 'OPEN=', WebSocket.OPEN)
			if (socket?.readyState === WebSocket.OPEN) {
				console.log('TldrawAgent: Sending audio chunk, data length:', data.length)
				socket.send(JSON.stringify({
					realtimeInput: {
						mediaChunks: [{
							mimeType: "audio/pcm;rate=24000",
							data: data
						}]
					}
				}))
			} else {
				console.warn('TldrawAgent: WebSocket not open, readyState:', readyState, ', cannot send audio')
			}
		})
	}

	stopAudio() {
		this.$isRecording.set(false)
		this.audioStreamer.stopRecording()
	}

	/**
	 * Send a text prompt to the agent.
	 */
	async prompt(input: AgentInput) {
		const request = this.getFullRequestFromInput(input)

		// Add user message to chat history
		const promptHistoryItem: ChatHistoryItem = {
			type: 'prompt',
			message: request.messages.join('\n'),
			contextItems: request.contextItems,
			selectedShapes: request.selectedShapes,
		}
		this.$chatHistory.update((prev) => [...prev, promptHistoryItem])

		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			await this.connect()
			// Wait for connection...
			await new Promise<void>((resolve) => {
				if (this.socket?.readyState === WebSocket.OPEN) resolve()
				else this.socket?.addEventListener('open', () => resolve(), { once: true })
			})
		}

		this.socket?.send(JSON.stringify({
			text: request.messages.join('\n')
		}))
	}

	/**
	 * Send a single request to the agent and handle its response.
	 * @deprecated Use prompt() instead.
	 */
	async request(input: AgentInput) {
		return this.prompt(input)
	}

	private socket: WebSocket | null = null
	private audioStreamer = new AudioStreamer()



	/**
	 * Schedule further work for the agent to do after this request has finished.
	 * What you schedule will get merged with the currently scheduled request, if there is one.
	 *
	 * @example
	 * ```tsx
	 * // Add an instruction
	 * agent.schedule('Add more detail.')
	 * ```
	 *
	 * @example
	 * ```tsx
	 * // Move the viewport
	 * agent.schedule({
	 *  bounds: { x: 0, y: 0, w: 100, h: 100 },
	 * })
	 * ```
	 *
	 * @example
	 * ```tsx
	 * // Add data to the request
	 * agent.schedule({ data: [value] })
	 * ```
	 */
	schedule(input: AgentInput) {
		const scheduledRequest = this.$scheduledRequest.get()

		// If there's no request scheduled yet, schedule one
		if (!scheduledRequest) {
			this.setScheduledRequest(input)
			return
		}

		const request = this.getPartialRequestFromInput(input)

		this.setScheduledRequest({
			type: 'schedule',

			// Append to properties where possible
			messages: [...scheduledRequest.messages, ...(request.messages ?? [])],
			contextItems: [...scheduledRequest.contextItems, ...(request.contextItems ?? [])],
			selectedShapes: [...scheduledRequest.selectedShapes, ...(request.selectedShapes ?? [])],
			data: [...scheduledRequest.data, ...(request.data ?? [])],

			// Override specific properties
			bounds: request.bounds ?? scheduledRequest.bounds,
			modelName: request.modelName ?? scheduledRequest.modelName,
		})
	}

	/**
	 * Manually override what the agent should do next.
	 *
	 * @example
	 * ```tsx
	 * agent.setScheduledRequest('Add more detail.')
	 * ```
	 *
	 * @example
	 * ```tsx
	 * agent.setScheduledRequest({
	 *  message: 'Add more detail to this area.',
	 *  bounds: { x: 0, y: 0, w: 100, h: 100 },
	 * })
	 * ```
	 *
	 * @example
	 * ```tsx
	 * // Cancel the scheduled request
	 * agent.setScheduledRequest(null)
	 * ```
	 *
	 * @param input - What to set the scheduled request to, or null to cancel
	 * the scheduled request.
	 */
	setScheduledRequest(input: AgentInput | null) {
		if (input === null) {
			this.$scheduledRequest.set(null)
			return
		}

		const request = this.getFullRequestFromInput(input)
		request.type = 'schedule'
		this.$scheduledRequest.set(request)
	}

	/**
	 * Add a todo item to the agent's todo list.
	 * @param text The text of the todo item.
	 * @returns The id of the todo item.
	 */
	addTodo(text: string) {
		const id = this.$todoList.get().length
		this.$todoList.update((todoItems) => {
			return [
				...todoItems,
				{
					id,
					status: 'todo' as const,
					text,
				},
			]
		})
		return id
	}

	/**
	 * Make the agent perform an action.
	 * @param action The action to make the agent do.
	 * @param helpers The helpers to use.
	 * @returns The diff of the action, and a promise for when the action is finished
	 */
	act(
		action: Streaming<AgentAction>,
		helpers = new AgentHelpers(this)
	): { diff: RecordsDiff<TLRecord>; promise: Promise<void> | null } {
		const { editor } = this
		const util = this.getAgentActionUtil(action._type)
		this.isActing = true

		let promise: Promise<void> | null = null
		let diff: RecordsDiff<TLRecord>
		try {
			diff = editor.store.extractingChanges(() => {
				promise = util.applyAction(structuredClone(action), helpers) ?? null
			})
		} finally {
			this.isActing = false
		}

		// Add the action to chat history
		if (util.savesToHistory()) {
			const historyItem: ChatHistoryItem = {
				type: 'action',
				action,
				diff,
				acceptance: 'pending',
			}

			this.$chatHistory.update((historyItems) => {
				// If there are no items, start off the chat history with the first item
				if (historyItems.length === 0) return [historyItem]

				// If the last item is still in progress, replace it with the new item
				const lastHistoryItem = historyItems.at(-1)
				if (
					lastHistoryItem &&
					lastHistoryItem.type === 'action' &&
					!lastHistoryItem.action.complete
				) {
					return [...historyItems.slice(0, -1), historyItem]
				}

				// Otherwise, just add the new item to the end of the list
				return [...historyItems, historyItem]
			})
		}

		return { diff, promise }
	}

	/**
	 * A function that cancels the agent's current prompt, if one is active.
	 */
	private cancelFn: (() => void) | null = null

	/**
	 * Cancel the agent's current prompt, if one is active.
	 */
	cancel() {
		this.cancelFn?.()
		this.$activeRequest.set(null)
		this.$scheduledRequest.set(null)
		this.cancelFn = null
	}

	/**
	 * Reset the agent's chat and memory.
	 * Cancel the current request if there's one active.
	 */
	reset() {
		this.cancel()
		this.$contextItems.set([])
		this.$todoList.set([])
		this.$userActionHistory.set([])

		const viewport = this.editor.getViewportPageBounds()
		this.$chatHistory.set([])
		this.$chatOrigin.set({ x: viewport.x, y: viewport.y })
	}

	/**
	 * Check if the agent is currently working on a request or not.
	 */
	isGenerating() {
		return this.$activeRequest.get() !== null
	}

	/**
	 * Whether the agent is currently acting on the editor or not.
	 * This flag is used to prevent agent actions from being recorded as user actions.
	 */
	private isActing = false

	/**
	 * Start recording user actions.
	 * @returns A cleanup function to stop recording user actions.
	 */
	private startRecordingUserActions() {
		const { editor } = this
		const cleanUpCreate = editor.sideEffects.registerAfterCreateHandler(
			'shape',
			(shape, source) => {
				if (source !== 'user') return
				if (this.isActing) return
				const change = {
					added: { [shape.id]: shape },
					updated: {},
					removed: {},
				}
				this.$userActionHistory.update((prev) => [...prev, change])
				return
			}
		)

		const cleanUpDelete = editor.sideEffects.registerAfterDeleteHandler(
			'shape',
			(shape, source) => {
				if (source !== 'user') return
				if (this.isActing) return
				const change = {
					added: {},
					updated: {},
					removed: { [shape.id]: shape },
				}
				this.$userActionHistory.update((prev) => [...prev, change])
				return
			}
		)

		const cleanUpChange = editor.sideEffects.registerAfterChangeHandler(
			'shape',
			(prev, next, source) => {
				if (source !== 'user') return
				if (this.isActing) return
				const change: RecordsDiff<TLRecord> = {
					added: {},
					updated: { [prev.id]: [prev, next] },
					removed: {},
				}
				this.$userActionHistory.update((prev) => [...prev, change])
				return
			}
		)

		function cleanUp() {
			cleanUpCreate()
			cleanUpDelete()
			cleanUpChange()
		}

		return cleanUp
	}

	/**
	 * A function that stops recording user actions.
	 */
	private stopRecordingFn: () => void

	/**
	 * Stop recording user actions.
	 */
	private stopRecordingUserActions() {
		this.stopRecordingFn?.()
	}

	/**
	 * Add a context item to the agent's context, ensuring that duplicates are
	 * not included.
	 *
	 * @param item The context item to add.
	 */
	addToContext(item: ContextItem) {
		this.$contextItems.update((items) => {
			// Don't add shapes that are already within context
			if (item.type === 'shapes') {
				const newItems = dedupeShapesContextItem(item, items)
				return [...items, ...newItems]
			}

			// Don't add items that are already in context
			if (this.hasContextItem(item)) {
				return items
			}

			return [...items, structuredClone(item)]
		})
	}

	/**
	 * Remove a context item from the agent's context.
	 * @param item The context item to remove.
	 */
	removeFromContext(item: ContextItem) {
		this.$contextItems.update((items) => items.filter((v) => item !== v))
	}

	/**
	 * Check if the agent's context contains a specific context item. This could
	 * mean as an individual item, or as part of a group of items.
	 *
	 * @param item The context item to check for.
	 * @returns True if the agent's context contains the item, false otherwise.
	 */
	hasContextItem(item: ContextItem) {
		const items = this.$contextItems.get()
		if (items.some((v) => areContextItemsEqual(v, item))) {
			return true
		}

		if (item.type === 'shape') {
			for (const existingItem of items) {
				if (existingItem.type === 'shapes') {
					if (existingItem.shapes.some((shape) => shape.shapeId === item.shape.shapeId)) {
						return true
					}
				}
			}
		}

		return false
	}

	/**
	 * Handle simplified drawing commands from the agent.
	 */
	private handleDrawingCommands(commands: any[]) {
		this.editor.store.mergeRemoteChanges(() => {
			commands.forEach(cmd => {
				try {
					if (cmd.type === 'create_shape') {
						const props = { ...cmd.props }
						if (props.text) {
							props.richText = toRichText(props.text)
							delete props.text
						}
						this.editor.createShape({
							type: cmd.shape_type || 'geo',
							x: cmd.x,
							y: cmd.y,
							props: props
						})
					} else if (cmd.type === 'create_text') {
						this.editor.createShape({
							type: 'text',
							x: cmd.x,
							y: cmd.y,
							props: { richText: toRichText(cmd.text) }
						})
					} else if (cmd.type === 'create_arrow') {
						this.editor.createShape({
							type: 'arrow',
							x: cmd.start.x,
							y: cmd.start.y,
							props: {
								start: { x: 0, y: 0 },
								end: { x: cmd.end.x - cmd.start.x, y: cmd.end.y - cmd.start.y }
							}
						})
					}
				} catch (e) {
					console.error('Error executing drawing command:', cmd, e)
				}
			})
		})
	}
}

/**
 * Check if two context items are equal.
 *
 * This is a helper function that is used internally by the agent.
 */
function areContextItemsEqual(a: ContextItem, b: ContextItem): boolean {
	if (a.type !== b.type) return false

	switch (a.type) {
		case 'shape': {
			const _b = b as ShapeContextItem
			return a.shape.shapeId === _b.shape.shapeId
		}
		case 'shapes': {
			const _b = b as ShapesContextItem
			if (a.shapes.length !== _b.shapes.length) return false
			return a.shapes.every((shape) => _b.shapes.find((s) => s.shapeId === shape.shapeId))
		}
		case 'area': {
			const _b = b as AreaContextItem
			return Box.Equals(a.bounds, _b.bounds)
		}
		case 'point': {
			const _b = b as PointContextItem
			return Vec.Equals(a.point, _b.point)
		}
		default: {
			exhaustiveSwitchError(a)
		}
	}
}

/**
 * Remove duplicate shapes from a shapes context item.
 * If there's only one shape left, return it as a shape item instead.
 *
 * This is a helper function that is used internally by the agent.
 */
function dedupeShapesContextItem(
	item: ShapesContextItem,
	existingItems: ContextItem[]
): ContextItem[] {
	// Get all shape IDs that are already in the context
	const existingShapeIds = new Set<string>()

	// Check individual shapes
	existingItems.forEach((contextItem) => {
		if (contextItem.type === 'shape') {
			existingShapeIds.add(contextItem.shape.shapeId)
		} else if (contextItem.type === 'shapes') {
			contextItem.shapes.forEach((shape: SimpleShape) => {
				existingShapeIds.add(shape.shapeId)
			})
		}
	})

	// Filter out shapes that are already in the context
	const newShapes = item.shapes.filter((shape) => !existingShapeIds.has(shape.shapeId))

	// Only add if there are remaining shapes
	if (newShapes.length > 0) {
		// If only one shape remains, add it as a single shape item
		if (newShapes.length === 1) {
			const newItem: ContextItem = {
				type: 'shape',
				shape: newShapes[0],
				source: item.source,
			}
			return [structuredClone(newItem)]
		}

		// Otherwise add as a shapes group
		const newItem: ContextItem = {
			type: 'shapes',
			shapes: newShapes,
			source: item.source,
		}
		return [structuredClone(newItem)]
	}

	// No new shapes to add
	return []
}

/**
 * Load an atom's value from local storage and persist it to local storage whenever it changes.
 *
 * This is a helper function that is used internally by the agent.
 */
function persistAtomInLocalStorage<T>(atom: Atom<T>, key: string) {
	const localStorage = globalThis.localStorage
	if (!localStorage) return

	try {
		const stored = localStorage.getItem(key)
		if (stored) {
			const value = JSON.parse(stored) as T
			atom.set(value)
		}
	} catch {
		console.warn(`Couldn't load ${key} from localStorage`)
	}

	react(`save ${key} to localStorage`, () => {
		localStorage.setItem(key, JSON.stringify(atom.get()))
	})
}

/**
 * Throw an error if a switch case is not exhaustive.
 *
 * This is a helper function that is used internally by the agent.
 */
function exhaustiveSwitchError(value: never, property?: string): never {
	const debugValue =
		property && value && typeof value === 'object' && property in value ? value[property] : value
	throw new Error(`Unknown switch case ${debugValue}`)
}
