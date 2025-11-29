import { Agent } from 'agents'
import { Environment } from '../environment'
import { VertexAIClient } from '../utils/VertexAIClient'
import { getSystemPrompt } from '../../shared/parts/SystemPromptPartUtil'
import { getAgentByName } from 'agents'
import { ExecutorAgent } from './ExecutorAgent'

interface LinterState {
    isListening: boolean
}

export class LinterAgent extends Agent<Environment, LinterState> {
    private client: VertexAIClient | null = null
    private executor: DurableObjectStub<ExecutorAgent> | null = null

    override initialState: LinterState = {
        isListening: false
    }

    async connect(sessionId: string) {
        if (this.client) return

        console.log('🎙️ LinterAgent: Connecting to Vertex AI...')
        this.client = new VertexAIClient()

        // Get Executor stub
        this.executor = (await getAgentByName(this.env.ExecutorAgent, sessionId)) as DurableObjectStub<ExecutorAgent>

        const baseSystemPrompt = getSystemPrompt()
        const systemPrompt = `
        ${baseSystemPrompt}

        ---
        ROLE: LISTENER & INSTRUCTOR

        You are the LISTENER agent.
        Your job is to:
        1. Listen to the user's voice input.
        2. Understand their intent (drawing, moving, modifying shapes).
        3. Convert that intent into a clear, text-based instruction for the Executor Agent.
        
        OUTPUT FORMAT:
        When you understand the user's request, call the "instruct_executor" tool with the description of the task.
        
        Example:
        User says: "Draw a blue box in the corner."
        You call tool: instruct_executor({ task: "Draw a blue rectangle in the top-left corner" })
        
        User says: "Connect the box to the circle."
        You call tool: instruct_executor({ task: "Connect the rectangle to the circle with an arrow" })

        Do NOT try to draw shapes yourself. You ONLY instruct the Executor.
        `

        await this.client.connect({
            systemInstruction: systemPrompt,
            tools: [{
                functionDeclarations: [{
                    name: 'instruct_executor',
                    description: 'Send a task instruction to the Executor Agent',
                    parameters: {
                        type: 'object',
                        properties: {
                            task: { type: 'string', description: 'The task description for the executor' }
                        },
                        required: ['task']
                    }
                }]
            }],
            generationConfig: {
                responseModalities: ['TEXT', 'AUDIO'], // We want audio back to confirm to user? Or just text? Let's ask for AUDIO too so it can talk back.
            }
        })

        // Subscribe to events
        this.client.subscribe(async (event) => {
            if (event.type === 'tool_call') {
                const { name, args } = event.functionCall
                if (name === 'instruct_executor') {
                    console.log('🎙️ LinterAgent: Instructing executor:', args.task)

                    // Call Executor
                    if (this.executor) {
                        // We fire and forget the executor task, or maybe we want to stream it back?
                        // For now, let's just trigger it. The Executor usually streams back to the client directly via the main DO loop.
                        // But here we might need to bridge it. 
                        // Actually, the AgentDurableObject handles the WebSocket to the client.
                        // If we want the Executor's actions to go to the client, we need a way to pipe them.

                        // Wait! The LinterAgent is running inside the Worker.
                        // The User's WebSocket is connected to AgentDurableObject.
                        // AgentDurableObject receives audio -> sends to LinterAgent.
                        // LinterAgent -> Vertex -> Tool Call -> LinterAgent.
                        // LinterAgent -> ExecutorAgent.

                        // The ExecutorAgent returns a stream of actions.
                        // We need to return these actions to the AgentDurableObject so it can send them to the client.

                        // However, AgentDurableObject is currently set up to call Planner/Executor directly based on text messages.
                        // For Audio, we need a new flow.
                    }

                    // Send success response to model
                    this.client?.sendToolResponse([{ name, response: { result: 'Instruction sent' } }])
                }
            } else if (event.type === 'content') {
                // If the model speaks back (AUDIO/TEXT), we might want to send this to the client?
                // For now, let's just log it.
                console.log('🎙️ LinterAgent: Model content:', event.text)
            }
        })
    }

    async processAudio(base64Audio: string) {
        if (!this.client) {
            // Auto-connect if not connected? We need sessionId though.
            // Assuming connect() is called first.
            console.warn('🎙️ LinterAgent: Client not connected, ignoring audio')
            return
        }
        await this.client.sendRealtimeInput(base64Audio)
    }

    async disconnect() {
        this.client?.disconnect()
        this.client = null
    }
}
