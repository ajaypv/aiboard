import { ExecutionContext } from '@cloudflare/workers-types'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { AutoRouter, cors, error, IRequest } from 'itty-router'
import { routeAgentRequest } from 'agents'
import { Environment } from './environment'
import { live } from './routes/live'
import { stream } from './routes/stream'
import { voice } from './routes/voice'

// Make the durable object available to the cloudflare worker
export { AgentDurableObject } from './do/AgentDurableObject'
export { VoiceDurableObject } from './do/VoiceDurableObject'
export { ChatAgent } from './agents/ChatAgent'
export { PlannerAgent } from './agents/PlannerAgent'
export { ExecutorAgent } from './agents/ExecutorAgent'
export { VerifierAgent } from './agents/VerifierAgent'
export { LinterAgent } from './agents/LinterAgent'

const { preflight, corsify } = cors({ origin: '*' })

const router = AutoRouter<IRequest, [env: Environment, ctx: ExecutionContext]>({
	before: [preflight],
	finally: [corsify],
	catch: (e) => {
		console.error(e)
		return error(e)
	},
})
	.post('/stream', stream)
	.get('/live', live)
	.get('/voice', voice)

export default class extends WorkerEntrypoint<Environment> {
	override async fetch(request: Request): Promise<Response> {
		// Try to handle with existing router first
		try {
			const response = await router.fetch(request, this.env, this.ctx)
			if (response.status !== 404) return response
		} catch (e) {
			// ignore
		}

		// If not found or error, try agent routing
		return (await routeAgentRequest(request, this.env)) || new Response("Not found", { status: 404 })
	}
}
