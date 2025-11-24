import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error } from 'itty-router'
import { AgentAction } from '../../shared/types/AgentAction'
import { AgentPrompt } from '../../shared/types/AgentPrompt'
import { Streaming } from '../../shared/types/Streaming'
import { Environment } from '../environment'
import { AgentService } from './AgentService'
import { buildSystemPrompt } from '../prompt/buildSystemPrompt'

export class AgentDurableObject extends DurableObject<Environment> {
	service: AgentService
	private activeSessions: Map<WebSocket, any> = new Map()

	constructor(ctx: DurableObjectState, env: Environment) {
		super(ctx, env)
		this.service = new AgentService(this.env) // swap this with your own service
	}

	private readonly router = AutoRouter({
		catch: (e) => {
			console.error(e)
			return error(e)
		},
	}).post('/stream', (request) => this.stream(request))

	// `fetch` is the entry point for all requests to the Durable Object
	override fetch(request: Request): Response | Promise<Response> {
		console.log('🎯 DO fetch called, URL:', request.url)

		// Check for WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade')
		console.log('🔍 DO Upgrade header:', upgradeHeader)

		if (upgradeHeader === 'websocket') {
			console.log('✅ DO detected WebSocket upgrade request')

			// Create WebSocket pair
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)

			console.log('🔗 DO created WebSocket pair')

			// Accept the server-side WebSocket
			// This connects it to the webSocketMessage handler
			this.ctx.acceptWebSocket(server)
			console.log('✅ DO accepted server WebSocket - messages will route to webSocketMessage()')

			// Return the client-side WebSocket
			return new Response(null, {
				status: 101,
				// @ts-ignore
				webSocket: client,
			})
		}

		console.log('📮 DO routing to normal handler')
		return this.router.fetch(request)
	}

	/**
	 * Stream changes from the model.
	 *
	 * @param request - The request object containing the prompt.
	 * @returns A Promise that resolves to a Response object containing the streamed changes.
	 */
	private async stream(request: Request): Promise<Response> {
		const encoder = new TextEncoder()
		const { readable, writable } = new TransformStream()
		const writer = writable.getWriter()

		const response: { changes: Streaming<AgentAction>[] } = { changes: [] }

			; (async () => {
				try {
					const prompt = (await request.json()) as AgentPrompt

					for await (const change of this.service.stream(prompt)) {
						response.changes.push(change)
						const data = `data: ${JSON.stringify(change)}\n\n`
						await writer.write(encoder.encode(data))
						await writer.ready
					}
					await writer.close()
				} catch (error: any) {
					console.error('Stream error:', error)

					// Send error through the stream
					const errorData = `data: ${JSON.stringify({ error: error.message })}\n\n`
					try {
						await writer.write(encoder.encode(errorData))
						await writer.close()
					} catch (writeError) {
						await writer.abort(writeError)
					}
				}
			})()

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
				'Transfer-Encoding': 'chunked',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
			},
		})
	}

	/**
	 * Handle incoming WebSocket messages for Live API
	 */
	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		console.log('📨 DO received WebSocket message from client')

		try {
			const promptData = JSON.parse(message as string)
			console.log('✅ Parsed prompt data')

			// Get auth token for Vertex AI
			const token = await this.getVertexAIToken()
			console.log('🔑 Got Vertex AI auth token')

			// Generate Plan with Gemini 3 Pro
			const userPrompt = this.getUserMessage(promptData)
			let finalPrompt = userPrompt

			try {
				// Notify client
				ws.send(JSON.stringify({
					type: 'action',
					action: {
						_type: 'message',
						message: '🧠 Consulting Gemini 3 Pro Architect for a plan...',
						complete: true,
						time: 0
					}
				}))

				const plan = await this.generatePlan(userPrompt, token)

				ws.send(JSON.stringify({
					type: 'action',
					action: {
						_type: 'message',
						message: '📝 Plan created! Executing now...',
						complete: true,
						time: 0
					}
				}))

				finalPrompt = `User Request: ${userPrompt}\n\nArchitect's Plan:\n${plan}\n\nExecute this plan on the whiteboard.`
			} catch (e) {
				console.error('Planning failed, continuing with original prompt', e)
				ws.send(JSON.stringify({
					type: 'action',
					action: {
						_type: 'message',
						message: '⚠️ Planner unavailable, proceeding directly...',
						complete: true,
						time: 0
					}
				}))
			}

			// Connect to Vertex AI Live API
			const vertexWsUrl = `wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent?access_token=${encodeURIComponent(token)}`
			console.log('🌐 Connecting to Vertex AI Live API...')

			const vertexWS = new WebSocket(vertexWsUrl)

			// Accumulate text from streaming responses
			let accumulatedText = ''
			let sentActionCount = 0
			let hasVerified = false

			vertexWS.addEventListener('open', () => {
				console.log('✅ Connected to Vertex AI')

				// Send setup message
				const setupMessage = {
					setup: {
						model: 'projects/x-micron-469410-g7/locations/global/publishers/google/models/gemini-2.0-flash-live-preview-04-09',
						generationConfig: {
							responseModalities: ['TEXT'],
						},
						systemInstruction: {
							parts: [{ text: this.getSystemPrompt(promptData) }]
						}
					}
				}

				console.log('📤 Sending setup to Vertex AI:', JSON.stringify(setupMessage, null, 2))
				vertexWS.send(JSON.stringify(setupMessage))
				console.log('✅ Setup sent successfully')

				// Send user message
				const userMessage = {
					clientContent: {
						turns: [{
							role: 'user',
							parts: [{ text: finalPrompt }]
						}],
						turnComplete: true
					}
				}

				console.log('📤 Sending user message to Vertex AI:', JSON.stringify(userMessage, null, 2))
				vertexWS.send(JSON.stringify(userMessage))
				console.log('✅ User message sent successfully')
			})

			vertexWS.addEventListener('message', (event) => {
				console.log('📨 Received from Vertex AI')
				try {
					// Decode ArrayBuffer if needed
					let jsonString: string
					if (event.data instanceof ArrayBuffer) {
						const decoder = new TextDecoder()
						jsonString = decoder.decode(event.data)
					} else {
						jsonString = event.data
					}

					const aiResponse = JSON.parse(jsonString)

					// Accumulate text from model turn parts
					if (aiResponse.serverContent?.modelTurn?.parts) {
						for (const part of aiResponse.serverContent.modelTurn.parts) {
							if (part.text) {
								accumulatedText += part.text
								console.log(`📝 Accumulated text length: ${accumulatedText.length}`)

								// Try to extract and send new actions incrementally
								const actions = this.extractActionsFromPartialText(accumulatedText)
								if (actions.length > sentActionCount) {
									const newActions = actions.slice(sentActionCount)
									for (const action of newActions) {
										// Ensure shapeId exists
										if (action.shape && !action.shape.shapeId) {
											action.shape.shapeId = 'shape'
										}

										ws.send(JSON.stringify({
											type: 'action',
											action: {
												...action,
												complete: true,
												time: 0
											}
										}))
										console.log('📤 Sent incremental action:', action._type)
									}
									sentActionCount = actions.length
								}
							}
						}
					}

					// When turn is complete
					if (aiResponse.serverContent?.turnComplete) {
						console.log('✅ Turn complete')

						if (!hasVerified) {
							console.log('🔍 Starting verification phase...')
							hasVerified = true

							// Send verification prompt
							const verifyMessage = {
								clientContent: {
									turns: [{
										role: 'user',
										parts: [{ text: "Review your drawing. Is it correct based on the plan? If there are any missing shapes or errors, fix them now. If it is correct, say 'Verification Complete'." }]
									}],
									turnComplete: true
								}
							}
							vertexWS.send(JSON.stringify(verifyMessage))

							// Notify client
							ws.send(JSON.stringify({
								type: 'action',
								action: {
									_type: 'message',
									message: '🔍 Verifying drawing...',
									complete: true,
									time: 0
								}
							}))

							// Reset for next turn
							accumulatedText = ''
							sentActionCount = 0
						} else {
							// Send completion
							ws.send(JSON.stringify({ type: 'complete' }))
							console.log('✅ Verification complete, closing Vertex WS')
							vertexWS.close()
						}
					}

					// Log any errors from Vertex AI
					if (aiResponse.error) {
						console.error('❌ Vertex AI returned error:', aiResponse.error)
						ws.send(JSON.stringify({
							type: 'error',
							error: aiResponse.error.message || 'Vertex AI error'
						}))
					}
				} catch (err: any) {
					console.error('❌ Error parsing AI response:', err)
					console.error('❌ Error stack:', err.stack)
				}
			})

			vertexWS.addEventListener('error', (error) => {
				console.error('❌ Vertex AI WebSocket error:', error)
				console.error('❌ Error details:', JSON.stringify(error))
				ws.send(JSON.stringify({
					type: 'error',
					error: 'Live API connection failed'
				}))
			})

			vertexWS.addEventListener('close', (event) => {
				console.log('🔌 Vertex AI WebSocket closed')
				console.log('📊 Close code:', event.code)
				console.log('📝 Close reason:', event.reason)
				console.log('🔍 Was clean:', event.wasClean)
			})

		} catch (error: any) {
			console.error('❌ WebSocket message error:', error)
			console.error('❌ Error stack:', error.stack)
			ws.send(JSON.stringify({
				type: 'error',
				error: error.message
			}))
		}
	}

	/**
	 * Get Vertex AI auth token
	 */
	private async getVertexAIToken(): Promise<string> {
		const LAMBDA_AUTH_URL = 'https://cgwuuuckpa.execute-api.ap-south-1.amazonaws.com/default/auth-lambad'
		const response = await fetch(LAMBDA_AUTH_URL)
		const authData = await response.json() as any
		return authData.auth?.access_token || authData.access_token
	}

	/**
	 * Get system prompt from prompt data
	 */
	private getSystemPrompt(promptData: any): string {
		return buildSystemPrompt(promptData)
	}

	/**
	 * Get user message from prompt data
	 */
	private getUserMessage(promptData: any): string {
		const messages = promptData.messages?.messages || []
		return messages.join('\n') || 'Hello'
	}

	/**
	 * Parse actions from AI text response
	 */
	private parseActionsFromText(text: string): any[] {
		// Try to extract JSON from text (remove markdown code fences if present)
		try {
			// Remove markdown code fences
			let cleanedText = text.replace(/```json\s*/g, '').replace(/```\s*/g, '')

			// Try to find JSON object or array
			const jsonMatch = cleanedText.match(/\{[\s\S]*\}/)
			if (jsonMatch) {
				const data = JSON.parse(jsonMatch[0])

				// If it has an actions array, extract and mark each as complete
				if (data.actions && Array.isArray(data.actions)) {
					return data.actions.map((action: any) => ({
						...action,
						complete: true,
						time: 0
					}))
				}

				// If it's a single action object with _type, mark it as complete
				if (data._type) {
					return [{
						...data,
						complete: true,
						time: 0
					}]
				}
			}
		} catch (err) {
			console.log('⚠️ Could not parse actions from text, returning as message')
		}

		// Return as message action if not JSON
		return [{
			_type: 'message',
			message: text,
			complete: true,
			time: 0
		}]
	}

	/**
	 * Generate a plan using Gemini 3 Pro Preview
	 */
	private async generatePlan(prompt: string, token: string): Promise<string> {
		console.log('🧠 Generating plan with Gemini 3 Pro Preview...')
		const projectId = 'x-micron-469410-g7'
		const location = 'global' // gemini-3-pro-preview might need 'us-central1' or 'global', let's try global first or check docs. 
		// Actually, for preview models, it's often us-central1. But let's stick to global if that's what we use elsewhere.
		// Wait, the existing code uses 'global' for the live model.
		// Let's try 'us-central1' for the REST API as it's safer for previews.
		const url = `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-3-pro-preview:generateContent`

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${token}`
			},
			body: JSON.stringify({
				contents: [{
					role: 'user',
					parts: [{
						text: `You are an expert technical illustrator and systems architect.
Your goal is to plan a diagram based on the user's request.
Analyze the request and describe the exact diagram to be drawn.
Specify:
1. The layout and structure.
2. The specific shapes to use (rectangles, circles, arrows, etc.).
3. The colors and styles. IMPORTANT: Always specify the 'fill' (none, semi, solid, pattern) and 'color' (black, blue, red, green, etc.) for every shape.
4. The text labels.

User Request: "${prompt}"

Provide a clear, detailed, step-by-step plan for drawing this diagram.
Do not output JSON or code. Just a descriptive plan.`
					}]
				}],
				generationConfig: {
					temperature: 0.7,
					maxOutputTokens: 2048
				}
			})
		})

		if (!response.ok) {
			const error = await response.text()
			console.error('❌ Planner failed:', error)
			throw new Error(`Planner failed: ${response.statusText}`)
		}

		const data = await response.json() as any
		const plan = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
		console.log('📝 Plan generated:', plan)
		return plan
	}

	/**
	 * Extract actions from partial text stream
	 */
	private extractActionsFromPartialText(text: string): any[] {
		const actions: any[] = []
		try {
			// Remove markdown
			let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '')

			// Find array start
			const arrayStart = clean.indexOf('[')
			if (arrayStart === -1) return []

			let depth = 0
			let start = -1
			let inString = false

			for (let i = arrayStart + 1; i < clean.length; i++) {
				const char = clean[i]

				if (char === '"' && clean[i - 1] !== '\\') {
					inString = !inString
					continue
				}

				if (inString) continue

				if (char === '{') {
					if (depth === 0) start = i
					depth++
				} else if (char === '}') {
					depth--
					if (depth === 0 && start !== -1) {
						// Found a potential object
						const jsonStr = clean.substring(start, i + 1)
						try {
							const action = JSON.parse(jsonStr)
							if (action._type) {
								actions.push(action)
							}
						} catch (e) {
							// Ignore invalid JSON
						}
						start = -1
					}
				}
			}
		} catch (e) {
			// Ignore errors
		}
		return actions
	}

	/**
	 * Handle WebSocket close
	 */
	override async webSocketClose(ws: WebSocket, code: number, reason: string) {
		console.log(`🔌 DO WebSocket closed. Code: ${code}, Reason: ${reason}`)
		this.activeSessions.delete(ws)
		console.log(`📊 Active sessions remaining: ${this.activeSessions.size}`)
	}

	/**
	 * Handle WebSocket errors
	 */
	override async webSocketError(ws: WebSocket, error: any) {
		console.error('❌ DO WebSocket error:', error)
		console.error('❌ Error details:', error?.message, error?.stack)
		this.activeSessions.delete(ws)
		console.log(`📊 Active sessions after error: ${this.activeSessions.size}`)
	}
}
