import { useValue } from 'tldraw'
import { TldrawAgent } from '../agent/TldrawAgent'

export function Suggestions({ agent }: { agent: TldrawAgent }) {
    const suggestions = useValue(agent.$suggestions)

    if (suggestions.length === 0) return null

    return (
        <div className="suggestions-container">
            <div className="suggestions-header">Suggested Topics</div>
            <div className="suggestions-list">
                {suggestions.map((suggestion, i) => (
                    <button
                        key={i}
                        className="suggestion-chip"
                        onClick={() => {
                            // Clear suggestions after clicking? Maybe not, let user explore multiple.
                            // But usually you want to clear them or replace them.
                            // The agent will likely generate new ones after the next turn.
                            agent.prompt(suggestion)
                        }}
                    >
                        {suggestion}
                    </button>
                ))}
            </div>
        </div>
    )
}
