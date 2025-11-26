import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error } from 'itty-router'
import { getAgentByName } from 'agents'
import { Environment } from '../environment'
import { PlannerAgent } from '../agents/PlannerAgent'
import { ExecutorAgent } from '../agents/ExecutorAgent'
import { VerifierAgent } from '../agents/VerifierAgent'

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
				const plannerState = await (planner as any).getState()
				const todoList = plannerState.todoList
				console.log('🔹 AgentDO: Current todo list:', JSON.stringify(todoList))

				// Find todo items
				const todoItem = todoList.find((item: any) => item.status === 'todo')
				if (todoItem) {
					console.log('🔹 AgentDO: Found todo item:', todoItem.text)
					// 4. Execute Task
					ws.send(JSON.stringify({
						type: 'action',
						action: {
							_type: 'message',
							message: `Planning task: ${todoItem.text}`,
							complete: true,
							time: 0
						}
					}))

					console.log('🔹 AgentDO: Calling executor...')
					const actions = await (executor as any).executeTask(todoItem.text, allShapes, bounds)
					console.log('🔹 AgentDO: Executor returned actions:', actions?.length)

					// Stream actions to client
					if (actions && actions.length > 0) {
						for (const action of actions) {
							console.log('🔹 AgentDO: Sending action to client:', action._type)

							ws.send(JSON.stringify({
								type: 'action',
								action: {
									...action,
									complete: true,
									time: 0
								}
							}))
						}

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
								message: `Task completed (no actions generated): ${todoItem.text}`,
								complete: true,
								time: 0
							}
						}))
					}

					// 5. Verify / Suggest
					if (isSuggesterEnabled) {
						console.log('🔹 AgentDO: Calling suggester (verifier)...')
						const suggestions = await (verifier as any).verifyActions(todoItem.text, actions, allShapes, bounds)
						console.log('🔹 AgentDO: Suggester returned actions:', suggestions?.length)

						if (suggestions && suggestions.length > 0) {
							ws.send(JSON.stringify({
								type: 'action',
								action: {
									_type: 'message',
									message: `Suggester: Found ${suggestions.length} improvements. Applying...`,
									complete: true,
									time: 0
								}
							}))

							for (const action of suggestions) {
								console.log('🔹 AgentDO: Sending suggestion to client:', action._type)
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
				} else {
					console.log('🔹 AgentDO: No todo items found')
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
