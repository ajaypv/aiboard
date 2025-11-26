import { Agent } from 'agents'
import { Environment } from '../environment'
import { AgentAction } from '../../shared/types/AgentAction'
import { VertexAIClient } from '../utils/VertexAIClient'
import { getSystemPrompt } from '../../shared/parts/SystemPromptPartUtil'

interface VerifierState {
    lastVerification: { status: 'approved' | 'rejected', feedback: string } | null
}

export class VerifierAgent extends Agent<Environment, VerifierState> {
    private client: VertexAIClient | null = null

    override initialState: VerifierState = {
        lastVerification: null
    }

    async verifyActions(task: string, actions: AgentAction[], contextItems: any[] = [], bounds: any = null) {
        if (!this.client) {
            this.client = new VertexAIClient()
            const baseSystemPrompt = getSystemPrompt()
            const systemPrompt = `
            ${baseSystemPrompt}

            ---
            ROLE: SUGGESTER / MONITOR
            
            You are the SUGGESTER agent.
            You monitor the actions performed by the Executor Agent.
            
            Your goal is to suggest improvements or refinements based on the user's intent and aesthetic quality.
            
            Check for:
            1. Aesthetic improvements (color, alignment, spacing).
            2. Clarity and readability.
            3. "Nice to have" details that the Executor might have missed.
            
            If you see something that could be improved, generate ACTIONS to fix it.
            For example:
            - "Change the color of the rectangle to blue to match the theme." -> Generate an 'update' action.
            - "Move the text slightly to the right." -> Generate a 'move' action.
            
            If everything looks great, return an empty actions array.
            
            Return a JSON object with an "actions" array:
            {
                "actions": [
                    { "_type": "update", ... }
                ]
            }
            `
            await this.client.connect(systemPrompt)
        }

        try {
            let contextString = ''
            if (contextItems && contextItems.length > 0) {
                contextString = `
                EXISTING SHAPES ON CANVAS (Including what was just drawn):
                ${JSON.stringify(contextItems, null, 2)}
                `
            }

            let boundsString = ''
            if (bounds) {
                boundsString = `
                VISIBLE CANVAS BOUNDS:
                x: ${bounds.x}, y: ${bounds.y}, w: ${bounds.w}, h: ${bounds.h}
                `
            }

            const prompt = `
            Original Task: ${task}
            
            ${boundsString}
            
            ${contextString}

            Actions Just Performed by Executor: ${JSON.stringify(actions, null, 2)}
            
            INSTRUCTION:
            Review the changes. If you have any suggestions (like changing color, moving shapes for better layout, etc.), generate the ACTIONS to perform those changes.
            If no changes are needed, return an empty "actions" array.
            `
            const text = await this.client.send(prompt)
            console.log('🔹 SuggesterAgent: Received response:', text)

            const jsonMatch = text.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0])
                if (data.actions) {
                    return data.actions
                }
            }
        } catch (error) {
            console.error('SuggesterAgent error:', error)
            this.client = null
        }

        return []
    }
}
