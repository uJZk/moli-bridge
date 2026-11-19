// Fixture-only SOCKS5 server: authenticated CONNECTs can reach only the local TLS fixture.
import net from 'node:net';

export function createSocks5Fixture({ fixturePort, allowedHosts, username, password, onConnected, onAuthFailure }) {
  return net.createServer(client => {
    let buffer = Buffer.alloc(0);
    let phase = 'greeting';
    let upstream;
    client.on('error', () => upstream?.destroy());
    const reject = reply => { client.end(Buffer.from(reply)); };
    const read = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) { client.destroy(); return; }
      while (true) {
        if (phase === 'greeting') {
          if (buffer.length < 2) return;
          const length = 2 + buffer[1];
          if (buffer.length < length) return;
          if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(2)) { reject([5, 255]); return; }
          buffer = buffer.subarray(length);
          client.write(Buffer.from([5, 2]));
          phase = 'auth';
        } else if (phase === 'auth') {
          if (buffer.length < 2) return;
          const userEnd = 2 + buffer[1];
          if (buffer.length < userEnd + 1) return;
          const length = userEnd + 1 + buffer[userEnd];
          if (buffer.length < length) return;
          const valid = buffer[0] === 1 && buffer.subarray(2, userEnd).toString() === username &&
            buffer.subarray(userEnd + 1, length).toString() === password;
          buffer = buffer.subarray(length);
          if (!valid) { onAuthFailure(); reject([1, 1]); return; }
          client.write(Buffer.from([1, 0]));
          phase = 'request';
        } else if (phase === 'request') {
          if (buffer.length < 5) return;
          if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0 || buffer[3] !== 3) { reject([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]); return; }
          const hostEnd = 5 + buffer[4];
          if (buffer.length < hostEnd + 2) return;
          const host = buffer.subarray(5, hostEnd).toString();
          const port = buffer.readUInt16BE(hostEnd);
          if (!allowedHosts.includes(host) || port !== 443) { reject([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]); return; }
          const remainder = buffer.subarray(hostEnd + 2);
          client.removeListener('data', read);
          client.pause();
          upstream = net.connect(fixturePort, '127.0.0.1', () => {
            onConnected(host, port);
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (remainder.length) upstream.write(remainder);
            upstream.pipe(client); client.pipe(upstream); client.resume();
          });
          upstream.on('error', () => client.destroy());
          return;
        } else return;
      }
    };
    client.on('data', read);
  });
}
