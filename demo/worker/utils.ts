export async function bufferText(textStream: ReadableStream, callBack: (sentence: string) => void) {
    let wordBuffer = '';
    let timeoutId: any;
    for await (const word of textStream as any) {
        if (timeoutId) clearTimeout(timeoutId);
        wordBuffer += word;

        // Match sentences ending with ., !, or ? followed by a space or end of string
        const sentenceRegex = /([^\r\n.?!]*[.?!])(\s|$)/g;
        let match;
        let lastIndex = 0;

        while ((match = sentenceRegex.exec(wordBuffer)) !== null) {
            const sentence = wordBuffer.slice(lastIndex, sentenceRegex.lastIndex).trim();
            if (sentence) callBack(sentence);
            lastIndex = sentenceRegex.lastIndex;
        }

        // Keep only the unfinished part in the wordBuffer
        wordBuffer = wordBuffer.slice(lastIndex);

        // Set a timer to process last buffer if no new word comes
        timeoutId = setTimeout(() => {
            if (wordBuffer) callBack(wordBuffer);
        }, 1000);
    }
}
