'use client'

import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { whiteboardAiService } from '../services/whiteboardAiService'

export default function Whiteboard() {
    return (
        <div className="w-full h-full relative bg-white">
            <Tldraw
                persistenceKey="aiboard-persistence"
                onMount={(editor) => {
                    whiteboardAiService.setEditor(editor);
                }}
            />
        </div>
    )
}
