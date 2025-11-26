import { Agent } from 'agents'
import { Environment } from '../environment'
import { VertexAIClient } from '../utils/VertexAIClient'
import { getSystemPrompt } from '../../shared/parts/SystemPromptPartUtil'

interface TodoItem {
    id: string
    text: string
    status: 'todo' | 'in-progress' | 'done'
}

interface PlannerState {
    todoList: TodoItem[]
    history: { role: 'user' | 'assistant', content: string }[]
}

export class PlannerAgent extends Agent<Environment, PlannerState> {
    private client: VertexAIClient | null = null

    override initialState: PlannerState = {
        todoList: [],
        history: []
    }

    override async onStart() {
        // Ensure state is initialized
        this.setState({
            todoList: this.state.todoList || [],
            history: this.state.history || []
        })
    }

    async updateTaskStatus(id: string, status: 'todo' | 'in-progress' | 'done') {
        const todoList = this.state.todoList.map((item) => {
            if (item.id === id) {
                return { ...item, status }
            }
            return item
        })
        this.setState({ ...this.state, todoList })
    }

    async addMessage(role: 'user' | 'assistant', content: string, contextItems: any[] = [], bounds: any = null) {
        // Update history
        const newHistory = [...this.state.history, { role, content }]
        this.setState({ ...this.state, history: newHistory })

        if (role === 'user') {
            await this.generatePlan(content, contextItems, bounds)
        }
    }

    async getState() {
        return this.state
    }

    private async generatePlan(userMessage: string, contextItems: any[] = [], bounds: any = null) {
        console.log('🔸 PlannerAgent: Generating plan for:', userMessage)

        if (!this.client) {
            this.client = new VertexAIClient()
            const baseSystemPrompt = getSystemPrompt()
            const systemPrompt = `
            ${baseSystemPrompt}

            ---
            ROLE: PLANNER
            
            You are the PLANNER agent.
            Your goal is NOT to draw, but to break down the user's request into a concrete Todo List for the Executor Agent.

            CRITICAL OVERRIDE:
            1. IGNORE all instructions in the base system prompt about drawing shapes, arrows, or returning "actions".
            2. Your ONLY output must be a raw JSON object with a "todoList" property.
            3. DO NOT generate drawing actions (like "create", "update-todo-list", "review").
            4. Do not include markdown formatting (like \`\`\`json).
            
            Expected Output Format:
            {
                "todoList": [
                    { "id": "1", "text": "Draw a blue rectangle", "status": "todo" },
                    { "id": "2", "text": "Connect it to the circle", "status": "todo" }
                ]
            }
            `
            await this.client.connect(systemPrompt)
        }

        try {
            console.log('🔸 PlannerAgent: Sending message to VertexAIClient...')

            let contextString = ''
            if (contextItems && contextItems.length > 0) {
                contextString = `
                EXISTING SHAPES ON CANVAS:
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

            // We append the current todo list to the prompt so the model knows the current state
            // even if it has context, it's good to be explicit about the *current* state object we are managing.
            const promptWithContext = `
            Current Todo List:
            ${JSON.stringify(this.state.todoList, null, 2)}
            
            ${boundsString}
            
            ${contextString}

            User Request: ${userMessage}
            `

            const text = await this.client.send(promptWithContext)
            console.log('🔸 PlannerAgent: Received response:', text)

            // Clean up markdown code blocks if present
            const cleanText = text.replace(/```json\n?|\n?```/g, '').trim()

            const jsonMatch = cleanText.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0])
                if (data.todoList) {
                    console.log('🔸 PlannerAgent: Updating todo list:', data.todoList)
                    this.setState({
                        ...this.state,
                        todoList: data.todoList
                    })
                }
            } else {
                console.warn('🔸 PlannerAgent: No JSON found in response')
            }
        } catch (error) {
            console.error('PlannerAgent error:', error)
            // If error, maybe reconnect next time
            this.client = null
        }
    }
}
