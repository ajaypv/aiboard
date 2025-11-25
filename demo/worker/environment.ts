export interface Environment {
	AGENT_DURABLE_OBJECT: DurableObjectNamespace
	VOICE_DURABLE_OBJECT: DurableObjectNamespace
	AI: any // Binding for Workers AI
	OPENAI_API_KEY: string
	ANTHROPIC_API_KEY: string
	GOOGLE_API_KEY: string
}
