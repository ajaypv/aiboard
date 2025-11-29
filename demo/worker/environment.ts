import { PlannerAgent } from './agents/PlannerAgent'
import { ExecutorAgent } from './agents/ExecutorAgent'
import { VerifierAgent } from './agents/VerifierAgent'
import { ChatAgent } from './agents/ChatAgent'
import { LinterAgent } from './agents/LinterAgent'

export interface Environment {
	AGENT_DURABLE_OBJECT: DurableObjectNamespace
	VOICE_DURABLE_OBJECT: DurableObjectNamespace
	ChatAgent: DurableObjectNamespace<ChatAgent>
	PlannerAgent: DurableObjectNamespace<PlannerAgent>
	ExecutorAgent: DurableObjectNamespace<ExecutorAgent>
	VerifierAgent: DurableObjectNamespace<VerifierAgent>
	LinterAgent: DurableObjectNamespace<LinterAgent>
	AI: any // Binding for Workers AI
	OPENAI_API_KEY: string
	ANTHROPIC_API_KEY: string
	GOOGLE_API_KEY: string
}
