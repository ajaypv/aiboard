export function decodeVertexAIResponse(data: any): any {
    // Handle ArrayBuffer (most common from WebSocket in Workers)
    if (data instanceof ArrayBuffer) {
        try {
            const text = new TextDecoder().decode(data);
            return JSON.parse(text);
        } catch (e) {
            console.error('Failed to decode ArrayBuffer:', e);
            return { error: 'Failed to decode ArrayBuffer' };
        }
    }

    if (typeof data === 'string') {
        try {
            return JSON.parse(data);
        } catch (e) {
            return { error: 'Failed to parse JSON' };
        }
    }

    // Handle Blob if necessary (usually in browser, but worker receives string/buffer)
    return data;
}
