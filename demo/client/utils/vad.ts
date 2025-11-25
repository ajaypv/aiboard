import { float32ToWav } from './audio';

const SAMPLE_RATE = 16000;

declare global {
    interface Window {
        vad: {
            MicVAD: {
                new: (options: any) => Promise<any>;
            };
        };
        stream: MediaStream;
    }
}

export async function startVad(onAudioBuffer: (buffer: ArrayBuffer) => void, onStatus: (status: string) => void) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true,
            sampleRate: SAMPLE_RATE,
        },
    });
    window.stream = stream; // make stream global

    // from https://github.com/ricky0123/vad
    const micVad = await window.vad.MicVAD.new({
        stream,
        model: 'v5',
        onSpeechStart: () => {
            onStatus('Listening...');
        },
        onSpeechEnd: (audio: Float32Array) => {
            onStatus('Transcribing...');
            const buff = float32ToWav(audio, SAMPLE_RATE);
            // playAudioBuffer(buff);
            onAudioBuffer(buff);
        },
    });
    micVad.start();
    return () => {
        micVad.pause();
        // micVad.destroy(); // If destroy is available, otherwise pause is usually enough or we can stop the stream
        if (window.stream) {
            window.stream.getTracks().forEach(track => track.stop());
        }
    };
}
