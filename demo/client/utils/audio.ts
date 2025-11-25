export function playAudioBuffer(buff: ArrayBuffer) {
    const blob = new Blob([buff], { type: 'audio/wav' });
    const url = window.URL.createObjectURL(blob);
    const audio = new Audio();
    audio.src = url;
    audio.play();
}

function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array) {
    for (let i = 0; i < input.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
}

export function float32ToWav(samples: Float32Array, sampleRate = 16000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // audio format (1 = PCM)
    view.setUint16(22, 1, true); // number of channels
    view.setUint32(24, sampleRate, true); // sample rate
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample

    // "data" sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // Write audio data
    floatTo16BitPCM(view, 44, samples);

    return buffer;
}

export function base64ToArrBuff(base64Str: string) {
    return Uint8Array.from(atob(base64Str), (c) => c.charCodeAt(0)).buffer;
}

const sounds: string[] = [];
let timeOutId: any = null;
let isSpeaking = false;
const playingSources: AudioBufferSourceNode[] = [];
const audioCtx = new AudioContext();

export function queueSound(sound: string, setStatus: (status: string) => void) {
    sounds.push(sound);
    playNext(setStatus);
}

export function stopPlaying() {
    playingSources.forEach((source) => {
        try {
            source.stop();
        } catch (e) {
            console.error('Error stopping source:', e);
        }
        sounds.splice(0, sounds.length);
        if (timeOutId) clearTimeout(timeOutId);
    });
}

function playNext(setStatus: (status: string) => void) {
    if (!isSpeaking && sounds?.length > 0) {
        isSpeaking = true;
        setStatus('AI Speaking...');
        const sound = sounds.shift();
        if (!sound) return;

        const arrayBuff = base64ToArrBuff(sound);
        audioCtx.decodeAudioData(arrayBuff).then((audioBuffer: AudioBuffer) => {
            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);
            source.start();
            playingSources.push(source);
            source.onended = () => {
                isSpeaking = false;
                setStatus('Listening...');
                playNext(setStatus);
            };
        });
    } else if (sounds.length > 0) {
        timeOutId = setTimeout(() => playNext(setStatus), 100);
    }
}
