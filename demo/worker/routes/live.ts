import { IRequest } from 'itty-router'
import { Environment } from '../environment'

/**
 * WebSocket route for Google Live API  
 * Simplified approach: Just pass to Durable Object
 */
export async function live(request: IRequest, env: Environment) {
    console.log('📞 /live route called')

    // Get Durable Object stub
    const id = env.AGENT_DURABLE_OBJECT.idFromName('anonymous')
    const stub = env.AGENT_DURABLE_OBJECT.get(id)

    console.log('📦 Forwarding directly to DO...')

    // Let the Durable Object handle the WebSocket directly
    return stub.fetch(request.url, {
        method: request.method,
        headers: request.headers,
    })
}
