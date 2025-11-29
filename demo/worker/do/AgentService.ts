import { AnthropicProvider, AnthropicProviderOptions, createAnthropic } from '@ai-sdk/anthropic'
import {
	createGoogleGenerativeAI,
	GoogleGenerativeAIProvider,
	GoogleGenerativeAIProviderOptions,
} from '@ai-sdk/google'
import { createOpenAI, OpenAIProvider } from '@ai-sdk/openai'
import { LanguageModel, streamText } from 'ai'
import { AgentAction } from '../../shared/types/AgentAction'
import { AgentPrompt } from '../../shared/types/AgentPrompt'
import { Streaming } from '../../shared/types/Streaming'
import { Environment } from '../environment'
import { AgentModelName, getAgentModelDefinition } from '../models'
import { buildMessages } from '../prompt/buildMessages'
import { buildSystemPrompt } from '../prompt/buildSystemPrompt'
import { getModelName } from '../prompt/getModelName'
import { closeAndParseJson } from './closeAndParseJson'

export const PROJECT_ID = "openodts";
export const LOCATION = "global";
export const LAMBDA_AUTH_URL = 'https://cgwuuuckpa.execute-api.ap-south-1.amazonaws.com/default/auth-lambad';

export async function getAuthToken(): Promise<string> {
	const authResponse = await fetch(LAMBDA_AUTH_URL);
	if (!authResponse.ok) {
		throw new Error(`Failed to get auth token: ${authResponse.status}`);
	}

	const authData = await authResponse.json() as any;
	const accessToken = authData.auth?.access_token || authData.access_token || authData.auth?.token || authData.token;

	if (!accessToken) {
		throw new Error('No access token received from Lambda');
	}

	return accessToken;
}

export class AgentService {
	openai: OpenAIProvider
	anthropic: AnthropicProvider
	google: GoogleGenerativeAIProvider

	constructor(env: Environment) {
		this.openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
		this.anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })
		this.google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY })
	}

	getModel(modelName: AgentModelName): LanguageModel | null {
		const modelDefinition = getAgentModelDefinition(modelName)
		const provider = modelDefinition.provider

		// google-live uses WebSocket, not the standard LanguageModel
		if (provider === 'google-live') {
			return null
		}

		return this[provider](modelDefinition.id)
	}

	async *stream(prompt: AgentPrompt): AsyncGenerator<Streaming<AgentAction>> {
		try {
			const modelName = getModelName(prompt)
			let model = this.getModel(modelName)

			// google-live models use WebSocket, not REST streaming
			if (model === null) {
				throw new Error(`Model ${modelName} requires WebSocket connection. Use /live endpoint instead.`)
			}

			// Special handling for Gemini models which require custom auth
			if (modelName === 'gemini-2.5-flash') {
				const token = await getAuthToken()
				const google = createGoogleGenerativeAI({
					baseURL: `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/`,
					headers: {
						Authorization: `Bearer ${token}`,
					},
					apiKey: 'no-key',
				})
				model = google(getAgentModelDefinition(modelName).id)
			}

			for await (const event of streamActions(model, prompt)) {
				yield event
			}
		} catch (error: any) {
			console.error('Stream error:', error)
			throw error
		}
	}
}

async function* streamActions(
	model: LanguageModel,
	prompt: AgentPrompt
): AsyncGenerator<Streaming<AgentAction>> {
	if (typeof model === 'string') {
		throw new Error('Model is a string, not a LanguageModel')
	}

	// Model-specific configuration
	let temperature = 0
	let maxOutputTokens = 8192
	let geminiThinkingBudget = 0

	if (model.modelId === 'gemini-2.5-pro') {
		temperature = 0
		maxOutputTokens = 8192
		geminiThinkingBudget = 128
	} else if (model.modelId === 'claude-sonnet-4-5') {
		temperature = 0
		maxOutputTokens = 8192
	} else if (model.modelId.startsWith('claude-')) {
		temperature = 0
		maxOutputTokens = 8192
	}

	const messages = buildMessages(prompt)
	const systemPrompt = buildSystemPrompt(prompt)

	try {
		// Only force response start for models that support it well
		if (model.provider === 'anthropic.messages' || model.provider === 'google.generative-ai') {
			messages.push({
				role: 'assistant',
				content: '{"actions": [{"_type":',
			})
		}
		const { textStream } = streamText({
			model,
			system: systemPrompt,
			messages,
			maxOutputTokens,
			temperature,
			providerOptions: {
				anthropic: {
					thinking: { type: 'disabled' },
				} satisfies AnthropicProviderOptions,
				google: {
					thinkingConfig: { thinkingBudget: geminiThinkingBudget },
				} satisfies GoogleGenerativeAIProviderOptions,
			},
			onError: (e) => {
				console.error('Stream text error:', e)
				throw e
			},
		})

		const canForceResponseStart =
			(model.provider === 'anthropic.messages' || model.provider === 'google.generative-ai')
		let buffer = canForceResponseStart ? '{"actions": [{"_type":' : ''
		let cursor = 0
		let maybeIncompleteAction: AgentAction | null = null

		let startTime = Date.now()
		for await (const text of textStream) {
			buffer += text

			const partialObject = closeAndParseJson(buffer)
			if (!partialObject) continue

			const actions = partialObject.actions
			if (!Array.isArray(actions)) continue
			if (actions.length === 0) continue

			// If the events list is ahead of the cursor, we know we've completed the current event
			// We can complete the event and move the cursor forward
			if (actions.length > cursor) {
				const action = actions[cursor - 1] as AgentAction
				if (action) {
					yield {
						...action,
						complete: true,
						time: Date.now() - startTime,
					}
					maybeIncompleteAction = null
				}
				cursor++
			}

			// Now let's check the (potentially new) current event
			// And let's yield it in its (potentially incomplete) state
			const action = actions[cursor - 1] as AgentAction
			if (action) {
				// If we don't have an incomplete event yet, this is the start of a new one
				if (!maybeIncompleteAction) {
					startTime = Date.now()
				}

				maybeIncompleteAction = action

				// Yield the potentially incomplete event
				yield {
					...action,
					complete: false,
					time: Date.now() - startTime,
				}
			}
		}

		// If we've finished receiving events, but there's still an incomplete event, we need to complete it
		if (maybeIncompleteAction) {
			yield {
				...maybeIncompleteAction,
				complete: true,
				time: Date.now() - startTime,
			}
		}
	} catch (error: any) {
		console.error('streamEventsVercel error:', error)
		throw error
	}
}
