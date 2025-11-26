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

    async executeTask(taskDescription: string, contextItems: any[] = [], bounds: any = null): Promise<ReadableStream<Uint8Array>> {
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
            
            OUTPUT FORMAT:
            Return a stream of JSON objects, where each object is an ACTION.
            Do NOT wrap them in an "actions" array.
            Output each JSON object on a NEW LINE.
            
            Example:
            { "_type": "create-shape", "type": "geo", "x": 100, "y": 100, "props": { "w": 100, "h": 100, "geo": "rectangle", "color": "blue" } }
            { "_type": "create-shape", "type": "geo", "x": 250, "y": 100, "props": { "w": 100, "h": 100, "geo": "ellipse", "color": "red" } }
            `
            await this.client.connect(systemPrompt)
        }

        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()

        // Start background processing
        this.streamActions(taskDescription, contextItems, bounds, writer, encoder).catch(err => {
            console.error('Background streaming error:', err)
            writer.abort(err)
        })

        return readable
    }

    private async streamActions(taskDescription: string, contextItems: any[], bounds: any, writer: WritableStreamDefaultWriter, encoder: TextEncoder) {
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
            4. STREAM YOUR RESPONSE as separate JSON objects.
            5. IMPORTANT: Do NOT pretty-print. Use COMPACT single-line JSON for each object.
            6. Do NOT wrap in markdown code blocks.
            `

            if (!this.client) throw new Error("Client not initialized")

            let buffer = ''
            for await (const chunk of this.client.stream(prompt)) {
                console.log('🔹 ExecutorAgent: Received chunk:', JSON.stringify(chunk))
                buffer += chunk

                let startIndex = buffer.indexOf('{')
                while (startIndex !== -1) {
                    let parsed = false
                    let balance = 0
                    let endIndex = -1

                    // Find the matching closing brace
                    for (let i = startIndex; i < buffer.length; i++) {
                        if (buffer[i] === '{') balance++
                        else if (buffer[i] === '}') balance--

                        if (balance === 0) {
                            endIndex = i
                            break
                        }
                    }

                    if (endIndex !== -1) {
                        // Found a complete block
                        const potentialJson = buffer.slice(startIndex, endIndex + 1)
                        try {
                            const action = JSON.parse(potentialJson)
                            console.log('🔹 ExecutorAgent: Yielding action:', action._type)

                            // Update state
                            this.setState({
                                ...this.state,
                                lastActions: [...this.state.lastActions, action]
                            })

                            await writer.write(encoder.encode(JSON.stringify(action) + '\n'))

                            // Advance buffer past this object
                            buffer = buffer.slice(endIndex + 1)
                            parsed = true
                        } catch (e) {
                            console.warn('🔹 ExecutorAgent: Failed to parse block:', potentialJson, e)
                            // If parse failed (e.g. brace inside string caused miscount), 
                            // we skip this starting brace and try again.
                            buffer = buffer.slice(startIndex + 1)
                            parsed = true
                        }
                    } else {
                        // Incomplete object, wait for more data
                        break
                    }

                    // Look for next object
                    if (parsed) {
                        startIndex = buffer.indexOf('{')
                    } else {
                        break
                    }
                }
            }

            console.log('🔹 ExecutorAgent: Stream finished. Remaining buffer:', buffer)

        } catch (error) {
            console.error('ExecutorAgent error:', error)
            this.client = null
            throw error
        } finally {
            await writer.close()
        }
    }
}
