import * as assert from 'assert';
import * as http from 'http';
import { listLocalModelIds } from '../../ui/localModelPicker';

suite('Local completion model picker', () => {
    test('lists model IDs from an authenticated local endpoint', async () => {
        let requestedPath: string | undefined;
        let authorization: string | undefined;
        const server = http.createServer((request, response) => {
            requestedPath = request.url;
            authorization = request.headers.authorization;
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ data: [
                { id: 'model-a' }, { id: 'model-b' }, { id: 'model-a' }, { id: 42 },
            ] }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            assert.deepStrictEqual(await listLocalModelIds(`http://127.0.0.1:${address.port}/v1/`, 'local-key'),
                ['model-a', 'model-b']);
            assert.strictEqual(requestedPath, '/v1/models');
            assert.strictEqual(authorization, 'Bearer local-key');
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('leaves manual model entry available when discovery is unsupported', async () => {
        assert.deepStrictEqual(await listLocalModelIds('', ''), []);
        assert.deepStrictEqual(await listLocalModelIds('file:///models', ''), []);
    });
});
