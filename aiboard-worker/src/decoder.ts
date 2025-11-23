export function decodeVertexAIResponse(data: any): any {
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
