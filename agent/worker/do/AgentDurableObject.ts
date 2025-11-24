import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error } from 'itty-router'
import { AgentAction } from '../../shared/types/AgentAction'
import { AgentPrompt } from '../../shared/types/AgentPrompt'
import { Streaming } from '../../shared/types/Streaming'
import { Environment } from '../environment'
import { AgentService } from './AgentService'
import { handleOptions, handleProxyWebSocket } from '../utils/websocket'

export class AgentDurableObject extends DurableObject<Environment> {
	service: AgentService
	private vertexConnections = new Map<WebSocket, WebSocket>() // Map client WS to Vertex WS

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
	override async fetch(request: Request): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return handleOptions()
		}

		if (request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)

			this.ctx.acceptWebSocket(server)

			// Set up Vertex AI connection and store the reference
			const vertexWs = await handleProxyWebSocket(server, this.env, (vertexWebSocket) => {
				// Store the Vertex AI WebSocket for this client
				this.vertexConnections.set(server, vertexWebSocket)
			})

			return new Response(null, {
				status: 101,
				webSocket: client,
			})
		}

		return this.router.fetch(request)
	}

	// Handle incoming WebSocket messages
	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// Parse the message
		const data = typeof message === 'string' ? JSON.parse(message) : JSON.parse(new TextDecoder().decode(message));

		// Get the Vertex AI WebSocket for this client
		const vertexWs = this.vertexConnections.get(ws)
		if (vertexWs && vertexWs.readyState === WebSocket.OPEN) {
			// Forward the message to Vertex AI
			if (data.realtimeInput) {
				vertexWs.send(JSON.stringify({
					realtimeInput: {
						mediaChunks: [{
							mimeType: "audio/pcm;rate=24000",
							data: data.realtimeInput.mediaChunks[0].data
						}]
					}
				}));
			} else if (data.text) {
				console.log('💬 DO: Forwarding text to Vertex AI:', data.text);
				vertexWs.send(JSON.stringify({
					clientContent: {
						turns: [{
							role: "user",
							parts: [{ text: data.text }]
						}],
						turnComplete: true
					}
				}));
			}
		} else {
			// console.warn('DO: No Vertex AI connection for this client WebSocket');
		}
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		console.log('DO: WebSocket closed', code, reason);

		// Close the Vertex AI connection if it exists
		const vertexWs = this.vertexConnections.get(ws)
		if (vertexWs) {
			vertexWs.close()
			this.vertexConnections.delete(ws)
		}

		ws.close(code, reason);
	}

	override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		console.error('DO: WebSocket error', error);
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
}
