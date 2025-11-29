import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error } from 'itty-router'
import { getAgentByName } from 'agents'
import { Environment } from '../environment'
import { PlannerAgent } from '../agents/PlannerAgent'
import { ExecutorAgent } from '../agents/ExecutorAgent'
import { VerifierAgent } from '../agents/VerifierAgent'
import { LinterAgent } from '../agents/LinterAgent'

export class AgentDurableObject extends DurableObject<Environment> {
	private activeSessions: Map<WebSocket, any> = new Map()

	constructor(ctx: DurableObjectState, env: Environment) {
		super(ctx, env)
	}

	private readonly router = AutoRouter({
		catch: (e) => {
			console.error(e)
			return error(e)
		},
	}).post('/stream', (request) => this.stream(request))

	override fetch(request: Request): Response | Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade')
		if (upgradeHeader === 'websocket') {
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			this.ctx.acceptWebSocket(server)
			return new Response(null, { status: 101, webSocket: client })
		}
		return this.router.fetch(request)
	}

	private async stream(request: Request): Promise<Response> {
		// Keep existing stream logic for backward compatibility if needed, 
		// or replace with agent calls. For now, we focus on WebSocket.
		return new Response('Stream endpoint deprecated in favor of WebSocket', { status: 400 })
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const data = JSON.parse(message as string)
			const sessionId = data.sessionId || ('session-' + this.ctx.id.toString())
			const isSuggesterEnabled = data.isSuggesterEnabled

			// 0. Get Linter Agent
			const linter = (await getAgentByName(this.env.LinterAgent, sessionId)) as unknown as DurableObjectStub<LinterAgent>

			// Handle Audio Data
			if (data.type === 'audio_data') {
				console.log('🔹 AgentDO: Received audio data, forwarding to Linter...')
				// Initialize Linter connection if needed (it handles idempotency)
				await (linter as any).connect(sessionId)

				// Forward audio
				await (linter as any).processAudio(data.data)
				return
			}

			console.log('🔹 AgentDO: Using session ID:', sessionId)
			console.log('🔹 AgentDO: Suggester enabled:', isSuggesterEnabled)

			// 1. Get Agents
			const planner = (await getAgentByName(this.env.PlannerAgent, sessionId)) as DurableObjectStub<PlannerAgent>
			const executor = (await getAgentByName(this.env.ExecutorAgent, sessionId)) as DurableObjectStub<ExecutorAgent>
			const verifier = (await getAgentByName(this.env.VerifierAgent, sessionId)) as DurableObjectStub<VerifierAgent>

			// 2. Forward user input to Planner
			const userText = data.messages?.messages?.[0] || ''
			console.log('🔹 AgentDO: Received user text:', userText)

			if (userText) {
				console.log('🔹 AgentDO: Adding message to planner...')

				// Extract shapes from contextItems
				const contextItemsPart = data.contextItems
				const contextShapes = contextItemsPart?.items?.flatMap((item: any) => {
					if (item.type === 'shape') return [item.shape]
					if (item.type === 'shapes') return item.shapes
					return []
				}) || []

				// Extract shapes from selectedShapes
				const selectedShapesPart = data.selectedShapes
				const selectedShapes = selectedShapesPart?.shapes || []

				// Combine all known shapes
				const allShapes = [...contextShapes, ...selectedShapes]

				// Extract bounds
				const viewportBoundsPart = data.viewportBounds
				const bounds = viewportBoundsPart?.agentBounds || null

				// Pass context to planner
				await (planner as any).addMessage('user', userText, allShapes, bounds)

				// 3. Check for new tasks
				console.log('🔹 AgentDO: Checking planner state...')
				let plannerState = await (planner as any).getState()
				let todoList = plannerState.todoList
				console.log('🔹 AgentDO: Current todo list:', JSON.stringify(todoList))

				// Find todo items
				let todoItem = todoList.find((item: any) => item.status === 'todo')

				// Initialize state tracking
				let currentShapes = [...allShapes]
				const allSessionActions: any[] = []

				while (todoItem) {
					console.log('🔹 AgentDO: Found todo item:', todoItem.text)
					// 4. Execute Task
					ws.send(JSON.stringify({
						type: 'action',
						action: {
							_type: 'message',
							message: `Planning task: ${todoItem.text} `,
							complete: true,
							time: 0
						}
					}))

					console.log('🔹 AgentDO: Calling executor...')
					const stream = await (executor as any).executeTask(todoItem.text, currentShapes, bounds)
					const reader = stream.getReader()
					const decoder = new TextDecoder()
					let buffer = ''

					const actions: any[] = []

					// Stream actions to client
					while (true) {
						const { done, value } = await reader.read()
						if (done) break

						buffer += decoder.decode(value, { stream: true })

						let newlineIndex = buffer.indexOf('\n')
						while (newlineIndex !== -1) {
							const line = buffer.slice(0, newlineIndex).trim()
							buffer = buffer.slice(newlineIndex + 1)

							if (line) {
								try {
									const action = JSON.parse(line)
									console.log('🔹 AgentDO: Sending action to client:', action._type)
									actions.push(action)
									allSessionActions.push(action)

									// Update local state
									if (action._type === 'create' && action.shape) {
										currentShapes.push(action.shape)
									} else if (action._type === 'update' && action.shape && action.shape.id) {
										const index = currentShapes.findIndex((s: any) => s.id === action.shape.id)
										if (index !== -1) {
											currentShapes[index] = { ...currentShapes[index], ...action.shape }
										}
									} else if (action._type === 'move' && (action.shapeId || action.id)) {
										const id = action.shapeId || action.id
										const index = currentShapes.findIndex((s: any) => s.id === id)
										if (index !== -1) {
											if (action.x !== undefined) currentShapes[index].x = action.x
											if (action.y !== undefined) currentShapes[index].y = action.y
										}
									} else if (action._type === 'delete' && (action.shapeId || action.id)) {
										const id = action.shapeId || action.id
										const index = currentShapes.findIndex((s: any) => s.id === id)
										if (index !== -1) {
											currentShapes.splice(index, 1)
										}
									}

									ws.send(JSON.stringify({
										type: 'action',
										action: {
											...action,
											complete: true,
											time: 0
										}
									}))
								} catch (e) {
									console.error('🔹 AgentDO: Error parsing action:', e)
								}
							}
							newlineIndex = buffer.indexOf('\n')
						}
					}

					console.log('🔹 AgentDO: Executor finished. Total actions:', actions.length)

					if (actions.length > 0) {
						// Mark task as done after successful execution
						console.log('🔹 AgentDO: Task executed successfully. Marking as done:', todoItem.id)
						await (planner as any).updateTaskStatus(todoItem.id, 'done')

					} else {
						console.log('🔹 AgentDO: No actions returned from executor. Forcing task completion to prevent loop.')
						// Force mark as done to prevent infinite loop
						await (planner as any).updateTaskStatus(todoItem.id, 'done')

						ws.send(JSON.stringify({
							type: 'action',
							action: {
								_type: 'message',
								message: `Task completed(no actions generated): ${todoItem.text} `,
								complete: true,
								time: 0
							}
						}))
					}

					// 5. Verify / Suggest
					if (isSuggesterEnabled) {
						console.log('🔹 AgentDO: Calling suggester (verifier)...')
						const suggestions = await (verifier as any).verifyActions(todoItem.text, actions, currentShapes, bounds)
						console.log('🔹 AgentDO: Suggester returned actions:', suggestions?.length)

						if (suggestions && suggestions.length > 0) {
							ws.send(JSON.stringify({
								type: 'action',
								action: {
									_type: 'message',
									message: `Suggester: Found ${suggestions.length} improvements.Applying...`,
									complete: true,
									time: 0
								}
							}))

							for (const action of suggestions) {
								console.log('🔹 AgentDO: Sending suggestion to client:', action._type)
								// Update local state with suggestions too!
								if (action._type === 'create' && action.shape) {
									currentShapes.push(action.shape)
								} else if (action._type === 'update' && action.shape && action.shape.id) {
									const index = currentShapes.findIndex((s: any) => s.id === action.shape.id)
									if (index !== -1) {
										currentShapes[index] = { ...currentShapes[index], ...action.shape }
									}
								}

								ws.send(JSON.stringify({
									type: 'action',
									action: {
										...action,
										complete: true,
										time: 0
									}
								}))
							}
						} else {
							console.log('🔹 AgentDO: No suggestions found.')
						}
					} else {
						console.log('🔹 AgentDO: Suggester disabled by user. Skipping.')
					}

					// Refresh state for next iteration
					plannerState = await (planner as any).getState()
					todoList = plannerState.todoList
					todoItem = todoList.find((item: any) => item.status === 'todo')
				}

				if (!todoList.find((item: any) => item.status === 'todo')) {
					console.log('🔹 AgentDO: All tasks completed.')
					ws.send(JSON.stringify({
						type: 'action',
						action: {
							_type: 'message',
							message: `All tasks completed! Running final verification...`,
							complete: true,
							time: 0
						}
					}))

					// Final Verification
					console.log('🔹 AgentDO: Running FINAL VERIFICATION...')

					// Use the tracked 'currentShapes' which represents the final state
					const suggestions = await (verifier as any).verifyActions("FINAL CHECK: Verify the entire diagram for consistency, unlinked arrows, and overlaps.", allSessionActions, currentShapes, bounds)

					if (suggestions && suggestions.length > 0) {
						ws.send(JSON.stringify({
							type: 'action',
							action: {
								_type: 'message',
								message: `Final Verification: Found ${suggestions.length} issues.Applying fixes...`,
								complete: true,
								time: 0
							}
						}))

						for (const action of suggestions) {
							console.log('🔹 AgentDO: Sending final fix to client:', action._type)
							ws.send(JSON.stringify({
								type: 'action',
								action: {
									...action,
									complete: true,
									time: 0
								}
							}))
						}
					} else {
						ws.send(JSON.stringify({
							type: 'action',
							action: {
								_type: 'message',
								message: `Final Verification: No issues found.Great job!`,
								complete: true,
								time: 0
							}
						}))
					}
				}
			}

		} catch (error: any) {
			console.error('WebSocket error:', error)
			ws.send(JSON.stringify({ type: 'error', error: error.message }))
		}
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string) {
		this.activeSessions.delete(ws)
	}

	override async webSocketError(ws: WebSocket, error: any) {
		this.activeSessions.delete(ws)
	}
}
