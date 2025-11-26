import { IRequest } from 'itty-router'
import { Environment } from '../environment'

export async function voice(request: IRequest, env: Environment) {
    if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 })
    }
    const id = env.VOICE_DURABLE_OBJECT.idFromName('voice-session')
    const stub = env.VOICE_DURABLE_OBJECT.get(id)
    // Ensure the URL is absolute, as stub.fetch might require it or fail with relative URLs
    const url = new URL(request.url, 'http://voice')

    // Pass the request details as an options object, similar to live.ts
    // This avoids issues with the itty-router Request object
    return stub.fetch(url.toString(), {
        method: request.method,
        headers: request.headers,
    })
}
