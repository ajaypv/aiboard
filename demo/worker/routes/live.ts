import { Environment } from '../environment'

/**
 * WebSocket route for Google Live API  
 * Simplified approach: Just pass to Durable Object
 */
export async function live(request: Request, env: Environment): Promise<Response> {
    console.log('📞 /live route called')

    // Check if this is a WebSocket upgrade request
    const upgradeHeader = request.headers.get('Upgrade')
    if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    try {
        // Get or create a session ID from query params or generate one
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('sessionId') || 'session-' + crypto.randomUUID()

        console.log('📦 Forwarding WebSocket to AgentDurableObject, sessionId:', sessionId)

        // Get the AgentDurableObject instance
        const id = env.AGENT_DURABLE_OBJECT.idFromName(sessionId)
        const stub = env.AGENT_DURABLE_OBJECT.get(id)

        // Forward the WebSocket upgrade request to the Durable Object
        // We need to create a new Request with the proper URL
        return stub.fetch(request.url, {
            method: request.method,
            headers: request.headers,
        })
    } catch (error: any) {
        console.error('Error in /live route:', error)
        return new Response(`Error: ${error.message}`, { status: 500 })
    }
}
