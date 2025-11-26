import { Agent } from 'agents'
import { Environment } from '../environment'
import { AgentAction } from '../../shared/types/AgentAction'
import { VertexAIClient } from '../utils/VertexAIClient'
import { getSystemPrompt } from '../../shared/parts/SystemPromptPartUtil'

interface ExecutorState {
    currentTask: string | null
    lastActions: AgentAction[]
}

export class ExecutorAgent extends Agent<Environment, ExecutorState> {
    private client: VertexAIClient | null = null

    override initialState: ExecutorState = {
        currentTask: null,
        lastActions: []
    }

    async executeTask(taskDescription: string, contextItems: any[] = [], bounds: any = null) {
        console.log('🔹 ExecutorAgent: Executing task:', taskDescription)
        this.setState({ ...this.state, currentTask: taskDescription })

        if (!this.client) {
            this.client = new VertexAIClient()
            const baseSystemPrompt = getSystemPrompt()
            const systemPrompt = `
            ${baseSystemPrompt}

            ---
            ROLE: EXECUTOR
            
            Your specific goal right now is to act as the EXECUTOR.
            You have been assigned a specific task from the Planner.
            
            Focus ONLY on visualizing this specific task.
            Return a JSON object with an "actions" array containing the drawing commands.
            Example:
            {
                "actions": [
                    { "_type": "create-shape", "type": "geo", "x": 100, "y": 100, "props": { "w": 100, "h": 100, "geo": "rectangle", "color": "blue" } }
                ]
            }
            `
            await this.client.connect(systemPrompt)
        }

        try {
            console.log('🔹 ExecutorAgent: Sending task to VertexAIClient...')

            let contextString = ''
            if (contextItems && contextItems.length > 0) {
                contextString = `
                EXISTING SHAPES ON CANVAS (DO NOT OVERLAP WITH THESE):
                ${JSON.stringify(contextItems, null, 2)}
                `
            }

            let boundsString = ''
            if (bounds) {
                boundsString = `
                VISIBLE CANVAS BOUNDS (Draw within these if possible, but find empty space):
                x: ${bounds.x}, y: ${bounds.y}, w: ${bounds.w}, h: ${bounds.h}
                `
            }

            const prompt = `
            Task to Execute: "${taskDescription}"
            
            ${boundsString}
            
            ${contextString}
            
            INSTRUCTION: 
            1. Check the "EXISTING SHAPES" list. 
            2. If creating NEW shapes, find an empty area on the canvas (within bounds if possible) that does NOT overlap with existing shapes.
            3. If modifying/moving EXISTING shapes, use the EXACT "id" or "shapeId" found in the "EXISTING SHAPES" list. Do not invent IDs.
            4. Calculate coordinates (x, y) carefully to avoid overlap.
            5. YOU MUST RETURN AT LEAST ONE ACTION. If you cannot draw anything, return a "message" action explaining why.

            CRITICAL OVERRIDE:
            1. DO NOT generate "update-todo-list" actions. The Planner manages the list.
            2. JUST DRAW. Focus on "create", "update", "move", "connect" actions.
            3. IGNORE the instruction in the base prompt about creating a todo item first.
            `
            const text = await this.client.send(prompt)
            console.log('🔹 ExecutorAgent: Received response:', text)

            const jsonMatch = text.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0])
                if (data.actions) {
                    console.log('🔹 ExecutorAgent: Parsed actions:', data.actions.length)
                    // Update state with actions for history/verification
                    this.setState({
                        ...this.state,
                        lastActions: [...this.state.lastActions, ...data.actions]
                    })

                    // Return actions to the caller (Orchestrator)
                    return data.actions
                }
            } else {
                console.warn('🔹 ExecutorAgent: No JSON found in response')
            }
        } catch (error) {
            console.error('ExecutorAgent error:', error)
            this.client = null
        }
        return []
    }
}
