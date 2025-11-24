
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8787/stream');

ws.on('open', function open() {
    console.log('Connected to server');
    ws.send(JSON.stringify({ type: 'hello' }));
    setTimeout(() => {
        ws.close();
        process.exit(0);
    }, 1000);
});

ws.on('message', function incoming(data) {
    console.log('Received:', data);
});

ws.on('error', function error(err) {
    console.error('Error:', err);
    process.exit(1);
});
