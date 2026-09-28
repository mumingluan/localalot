import * as assert from 'assert';
import { AnthropicAdapter } from '../../completions/shared/llm/anthropicAdapter';
import { OpenAIResponseAdapter } from '../../completions/shared/llm/openaiResponseAdapter';
import { OpenAIChatCompletionAdapter } from '../../completions/shared/llm/openaiChatCompletionAdapter';
import { OpenAICompletionAdapter } from '../../completions/shared/llm/openaiCompletionAdapter';
import { OpenAIFimCompletionAdapter } from '../../completions/shared/llm/openaiFimCompletionAdapter';
import { ILLMAdapter } from '../../completions/shared/llm/llmAdapter';
import { iterateSSEStream } from '../../completions/shared/llm/sseStream';
import type { LLMRequest } from '../../completions/shared/llm/llmRequest';

suite('LLM adapter protocol mapping', () => {
    const originalFetch = globalThis.fetch;
    const eventBytes = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    async function nextSoon<T>(pending: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                pending,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('SSE delta was not yielded before stream completion')), 1_000);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    teardown(() => {
        globalThis.fetch = originalFetch;
    });

    test('API errors do not echo source prompts in adapter exceptions', async () => {
        const secret = 'PRIVATE_SOURCE_MARKER_926';
        globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'model missing' } }), {
            status: 400, headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
        const adapters: ILLMAdapter[] = [
            new OpenAIChatCompletionAdapter(),
            new OpenAICompletionAdapter({ debug() {}, error() {} } as never),
            new OpenAIFimCompletionAdapter({ debug() {}, error() {} } as never),
        ];
        const request: LLMRequest = {
            baseUrl: 'https://example.test', apiKey: '', model: 'model',
            prompt: secret, suffix: secret, messages: [{ role: 'user', content: secret }],
            max_tokens: 32, temperature: 0, stream: true,
        };
        for (const adapter of adapters) {
            await assert.rejects(adapter.send(request), error => {
                assert.match(String(error), /400.*model missing/);
                assert.ok(!String(error).includes(secret));
                return true;
            });
            await assert.rejects(async () => {
                for await (const _chunk of adapter.sendStream!(request)) { /* consume */ }
            }, error => {
                assert.match(String(error), /400.*model missing/);
                assert.ok(!String(error).includes(secret));
                return true;
            });
        }
    });

    test('HTTP 200 stream error events fail every local completion protocol', async () => {
        const cases: Array<{ adapter: ILLMAdapter; event: unknown }> = [
            { adapter: new OpenAIChatCompletionAdapter(), event: { error: { message: 'model missing' }, prompt: 'PRIVATE_SOURCE_MARKER' } },
            { adapter: new OpenAICompletionAdapter({ debug() {}, error() {} } as never), event: { error: { message: 'model missing' } } },
            { adapter: new OpenAIFimCompletionAdapter({ debug() {}, error() {} } as never), event: { error: { message: 'model missing' } } },
            { adapter: new OpenAIResponseAdapter(), event: { type: 'response.failed', response: { error: { message: 'model missing' } } } },
            { adapter: new AnthropicAdapter(), event: { type: 'error', error: { message: 'model missing' } } },
        ];
        const request: LLMRequest = {
            baseUrl: 'https://example.test', apiKey: '', model: 'model',
            prompt: 'source', messages: [{ role: 'user', content: 'source' }],
            max_tokens: 32, temperature: 0, stream: true,
        };
        for (const { adapter, event } of cases) {
            globalThis.fetch = (async () => new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
                status: 200, headers: { 'content-type': 'text/event-stream' },
            })) as typeof fetch;
            for (const run of [
                () => adapter.send(request),
                async () => { for await (const _chunk of adapter.sendStream!(request)) { /* consume */ } },
            ]) {
                await assert.rejects(run, error => {
                    assert.match(String(error), /model missing/);
                    assert.ok(!String(error).includes('PRIVATE_SOURCE_MARKER'));
                    return true;
                });
            }
        }
    });

    test('local endpoints omit empty credentials and keep configured credentials', async () => {
        const adapters: Array<{ make: () => ILLMAdapter; response: unknown; header: string; value: string }> = [
            { make: () => new OpenAIChatCompletionAdapter(), response: { choices: [{ message: { content: 'ok' } }] },
                header: 'authorization', value: 'Bearer key' },
            { make: () => new OpenAICompletionAdapter({ debug() {}, error() {} } as never),
                response: { choices: [{ text: 'ok' }] }, header: 'authorization', value: 'Bearer key' },
            { make: () => new OpenAIFimCompletionAdapter({ debug() {}, error() {} } as never),
                response: { choices: [{ text: 'ok' }] }, header: 'authorization', value: 'Bearer key' },
            { make: () => new OpenAIResponseAdapter(), response: { output: [{ content: [{ text: 'ok' }] }] },
                header: 'authorization', value: 'Bearer key' },
            { make: () => new AnthropicAdapter(), response: { content: [{ text: 'ok' }] },
                header: 'x-api-key', value: 'key' },
        ];
        for (const entry of adapters) {
            for (const apiKey of ['', 'key']) {
                let headers: Headers | undefined;
                globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
                    headers = new Headers(init?.headers);
                    return new Response(JSON.stringify(entry.response), {
                        status: 200, headers: { 'content-type': 'application/json' },
                    });
                }) as typeof fetch;
                const request: LLMRequest = {
                    baseUrl: 'https://example.test', apiKey, model: 'model',
                    prompt: 'prefix', messages: [{ role: 'user', content: 'prefix' }],
                    max_tokens: 32, temperature: 0, stream: false,
                };
                await entry.make().send(request);
                assert.strictEqual(headers?.get(entry.header), apiKey ? entry.value : null);
            }
        }
    });

    for (const { name, makeAdapter, chat } of [
        { name: 'chat/completions', makeAdapter: () => new OpenAIChatCompletionAdapter(), chat: true },
        { name: 'completions', makeAdapter: () => new OpenAICompletionAdapter({ debug() {}, error() {} } as never), chat: false },
        { name: 'fim/completions', makeAdapter: () => new OpenAIFimCompletionAdapter({ debug() {}, error() {} } as never), chat: false },
    ]) {
        test(`${name} preserves consecutive identical SSE deltas`, async () => {
            const event = (value: string) => JSON.stringify({
                choices: [chat ? { index: 0, delta: { content: value } } : { index: 0, text: value }],
            });
            const body = ['a', 'a', 'b'].map(value => `data: ${event(value)}\n\n`).join('') + 'data: [DONE]\n\n';
            globalThis.fetch = (async () => new Response(body, {
                status: 200, headers: { 'content-type': 'text/event-stream' },
            })) as typeof fetch;
            const adapter: ILLMAdapter = makeAdapter();
            const request = {
                baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
                prompt: 'prefix', messages: [{ role: 'user' as const, content: 'prefix' }],
                max_tokens: 32, temperature: 0, top_p: 1, n: 1, stream: true,
            };

            assert.strictEqual((await adapter.send(request)).text, 'aab');
            const iterator = adapter.sendStream(request);
            const chunks: string[] = [];
            let finalText = '';
            while (true) {
                const step = await iterator.next();
                if (step.done) {
                    finalText = step.value.text;
                    break;
                }
                chunks.push(step.value);
            }
            assert.deepStrictEqual(chunks, ['a', 'a', 'b']);
            assert.strictEqual(finalText, 'aab');
        });

        test(`${name} keeps a final newline-leading delta without an SSE terminator`, async () => {
            const completion = '\n    image: nginx';
            const event = { choices: [chat
                ? { index: 0, delta: { content: completion }, finish_reason: 'stop' }
                : { index: 0, text: completion, finish_reason: 'stop' }] };
            globalThis.fetch = (async () => new Response(`data: ${JSON.stringify(event)}`, {
                status: 200, headers: { 'content-type': 'text/event-stream' },
            })) as typeof fetch;
            const adapter: ILLMAdapter = makeAdapter();
            const request = {
                baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
                prompt: 'services:\n  web:', messages: [{ role: 'user' as const, content: 'services:\n  web:' }],
                max_tokens: 32, temperature: 0, stream: true,
            };
            assert.strictEqual((await adapter.send(request)).text, completion);
            const stream = adapter.sendStream(request);
            assert.strictEqual((await stream.next()).value, completion);
            const final = await stream.next();
            assert.strictEqual(final.done, true);
            assert.strictEqual(final.value.text, completion);
        });
    }

    test('SSE parser joins multiline data split across network chunks', async () => {
        const payload = JSON.stringify({ choices: [{ index: 0, text: 'ready' }] });
        const split = payload.indexOf(',') + 1;
        const parts = [`event: completion\r\ndata: ${payload.slice(0, split)}\r`,
            `\ndata: ${payload.slice(split)}\r\n\r\n`];
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
                controller.close();
            },
        });
        const events: unknown[] = [];
        for await (const event of iterateSSEStream(new Response(body))) events.push(event);
        assert.deepStrictEqual(events, [{ choices: [{ index: 0, text: 'ready' }] }]);
    });

    test('SSE parser keeps consecutive complete data lines without blank separators', async () => {
        const first = { choices: [{ index: 0, text: 'a' }] };
        const second = { choices: [{ index: 0, text: 'b' }] };
        const body = `data: ${JSON.stringify(first)}\ndata: ${JSON.stringify(second)}\n`;
        const events: unknown[] = [];
        for await (const event of iterateSSEStream(new Response(body))) events.push(event);
        assert.deepStrictEqual(events, [first, second]);
    });

    test('aborting an idle SSE reader cancels the response body promptly', async () => {
        let canceled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() { canceled = true; },
        });
        const controller = new AbortController();
        const iterator = iterateSSEStream(new Response(body), controller.signal);
        const pending = iterator.next();
        controller.abort();

        const result = await nextSoon(pending);
        assert.strictEqual(result.done, true);
        assert.strictEqual(canceled, true);
    });

    test('closing a completed ghost line cancels its unfinished SSE stream', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let canceled = false;
        const body = new ReadableStream<Uint8Array>({
            start(value) { controller = value; },
            cancel() { canceled = true; },
        });
        globalThis.fetch = (async () => new Response(body, {
            status: 200, headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch;
        const iterator = new OpenAICompletionAdapter({ debug() {}, error() {} } as never).sendStream({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model', prompt: 'const value = ',
            max_tokens: 32, temperature: 0, stream: true,
        });
        const first = iterator.next();
        controller.enqueue(eventBytes({ choices: [{ index: 0, text: 'ready\n' }] }));
        assert.strictEqual((await nextSoon(first)).value, 'ready\n');
        await nextSoon(iterator.return({ text: 'ready', finishReason: 'stop' }));
        assert.strictEqual(canceled, true);
    });

    test('Responses yields before completion and holds a stop split across events', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
        globalThis.fetch = (async () => new Response(stream, {
            status: 200, headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch;
        const iterator = new OpenAIResponseAdapter().sendStream({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
            messages: [{ role: 'user', content: 'complete' }],
            max_tokens: 32, temperature: 0, stream: true, stop: ['<END>'],
        });
        try {
            const firstPending = iterator.next();
            controller.enqueue(eventBytes({ type: 'response.output_text.delta', delta: 'hello<' }));
            const first = await nextSoon(firstPending);
            assert.strictEqual(first.done, false);
            assert.strictEqual(first.value, 'hello');
            controller.enqueue(eventBytes({ type: 'response.output_text.delta', delta: 'END>ignored' }));
            const final = await nextSoon(iterator.next());
            assert.strictEqual(final.done, true);
            assert.strictEqual(final.value.text, 'hello');
        } finally {
            try { controller.close(); } catch { /* already closed */ }
        }
    });

    test('Responses ignores non-text delta payloads in both reading paths', async () => {
        const body = [
            { type: 'response.output_text.delta', delta: { type: 'annotation_added' } },
            { type: 'response.output_text.delta', delta: { text: 'hello' } },
            { type: 'response.output_text.delta', delta: ' world' },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
        globalThis.fetch = (async () => new Response(body, {
            status: 200, headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch;
        const request = {
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
            messages: [{ role: 'user' as const, content: 'complete' }],
            max_tokens: 32, temperature: 0, stream: true,
        };

        assert.strictEqual((await new OpenAIResponseAdapter().send(request)).text, 'hello world');
        const iterator = new OpenAIResponseAdapter().sendStream(request);
        const chunks: string[] = [];
        while (true) {
            const step = await iterator.next();
            if (step.done) {
                assert.strictEqual(step.value.text, 'hello world');
                break;
            }
            chunks.push(step.value);
        }
        assert.deepStrictEqual(chunks, ['hello', ' world']);
    });

    test('Anthropic yields each text delta before message completion', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
        globalThis.fetch = (async () => new Response(stream, {
            status: 200, headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch;
        const iterator = new AnthropicAdapter().sendStream({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
            messages: [{ role: 'user', content: 'complete' }],
            max_tokens: 32, temperature: 0, stream: true,
        });
        try {
            const firstPending = iterator.next();
            controller.enqueue(eventBytes({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } }));
            const first = await nextSoon(firstPending);
            assert.strictEqual(first.done, false);
            assert.strictEqual(first.value, 'one');
            controller.enqueue(eventBytes({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'two' } }));
            controller.enqueue(eventBytes({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
            const second = await nextSoon(iterator.next());
            const final = await nextSoon(iterator.next());
            assert.strictEqual(second.value, 'two');
            assert.strictEqual(final.done, true);
            assert.strictEqual(final.value.text, 'onetwo');
            assert.strictEqual(final.value.finishReason, 'end_turn');
        } finally {
            try { controller.close(); } catch { /* already closed */ }
        }
    });

    test('Responses sends semantic context and applies configured stops client-side', async () => {
        let requestBody: Record<string, unknown> | undefined;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({ output_text: 'first\nsecond' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const result = await new OpenAIResponseAdapter().send({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
            messages: [{ role: 'user', content: 'complete this' }],
            context: ['# symbol: Widget', 'defined in widget.ts'],
            max_tokens: 32, temperature: 0, top_p: 0.8, stop: ['\n'],
        });

        assert.strictEqual(result.text, 'first');
        assert.strictEqual(requestBody?.top_p, 0.8);
        assert.deepStrictEqual((requestBody?.input as Array<Record<string, unknown>>)[0], {
            role: 'developer',
            content: '# symbol: Widget\n\ndefined in widget.ts',
        });
    });

    test('OpenAI reasoning requests use endpoint-specific token and sampling fields', async () => {
        const requestBodies: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return new Response(JSON.stringify({
                output_text: '42', choices: [{ message: { content: '42' } }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const request = {
            baseUrl: 'https://example.test', apiKey: 'key', model: 'gpt-5',
            family: 'openai-gpt5', messages: [{ role: 'user' as const, content: 'Next line?' }],
            max_tokens: 2048, temperature: 0, top_p: 1,
            presence_penalty: 1, frequency_penalty: 1,
            capabilities: { reasoning_effort: 'medium' },
        };

        await new OpenAIResponseAdapter().send(request);
        await new OpenAIChatCompletionAdapter().send(request);
        const [responsesBody, chatBody] = requestBodies;
        assert.deepStrictEqual(responsesBody.reasoning, { effort: 'medium' });
        assert.strictEqual(responsesBody.max_output_tokens, 2048);
        assert.strictEqual(responsesBody.temperature, undefined);
        assert.strictEqual(responsesBody.top_p, undefined);
        assert.strictEqual(chatBody.reasoning_effort, 'medium');
        assert.strictEqual(chatBody.reasoning, undefined);
        assert.strictEqual(chatBody.max_completion_tokens, 2048);
        assert.strictEqual(chatBody.max_tokens, undefined);
        for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
            assert.strictEqual(chatBody[key], undefined, key);
        }

        await new OpenAIChatCompletionAdapter().send({
            ...request, family: 'standard', capabilities: {},
        });
        assert.strictEqual(requestBodies[2].max_tokens, 2048);
        assert.strictEqual(requestBodies[2].temperature, 0);
    });

    test('Responses finds assistant text after a reasoning output item', async () => {
        const payload = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'reasoning' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'src/a.ts:7' }] },
            ],
        };
        const request = {
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
            messages: [{ role: 'user' as const, content: 'Next edit?' }],
            max_tokens: 2048, temperature: 0, stream: false,
        };
        globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
            status: 200, headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
        assert.strictEqual((await new OpenAIResponseAdapter().send(request)).text, 'src/a.ts:7');

        globalThis.fetch = (async () => new Response(
            `data: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )) as typeof fetch;
        assert.strictEqual((await new OpenAIResponseAdapter().send(request)).text, 'src/a.ts:7');
        const chunks: string[] = [];
        const iterator = new OpenAIResponseAdapter().sendStream(request);
        while (true) {
            const step = await iterator.next();
            if (step.done) {
                assert.strictEqual(step.value.text, 'src/a.ts:7');
                break;
            }
            chunks.push(step.value);
        }
        assert.deepStrictEqual(chunks, ['src/a.ts:7']);
    });

    test('Responses preserves output-limit completion status in JSON and SSE', async () => {
        const payload = {
            status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial edit' }] }],
        };
        const request = {
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model',
            messages: [{ role: 'user' as const, content: 'Next edit?' }],
            max_tokens: 32, temperature: 0, stream: true,
        };
        globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
            status: 200, headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
        assert.deepStrictEqual(await new OpenAIResponseAdapter().send(request), {
            text: 'partial edit', finishReason: 'max_output_tokens',
        });

        globalThis.fetch = (async () => new Response(
            `data: ${JSON.stringify({ type: 'response.incomplete', response: payload })}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )) as typeof fetch;
        assert.strictEqual((await new OpenAIResponseAdapter().send(request)).finishReason, 'max_output_tokens');
        const iterator = new OpenAIResponseAdapter().sendStream(request);
        assert.deepStrictEqual(await iterator.next(), { value: 'partial edit', done: false });
        assert.deepStrictEqual(await iterator.next(), {
            value: { text: 'partial edit', finishReason: 'max_output_tokens' }, done: true,
        });
    });

    test('completion endpoints preserve structured ghost metadata', async () => {
        let requestBody: Record<string, unknown> | undefined;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({ choices: [{ text: 'value', finish_reason: 'stop' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        await new OpenAICompletionAdapter({ debug() {}, error() {} } as never).send({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'model', prompt: 'x',
            max_tokens: 32, temperature: 0,
            extra: { language: 'yaml', next_indent: 2, trim_by_indentation: false, prompt_tokens: 8, suffix_tokens: 2 },
        });

        assert.deepStrictEqual(requestBody?.extra, {
            language: 'yaml', next_indent: 2, trim_by_indentation: false, prompt_tokens: 8, suffix_tokens: 2,
        });
    });

    test('Anthropic reserves answer tokens when manual thinking is enabled', async () => {
        let requestBody: Record<string, unknown> | undefined;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({ content: [{ text: 'ok' }], stop_reason: 'end_turn' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        await new AnthropicAdapter().send({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'claude-sonnet-4-5-20250929',
            messages: [{ role: 'system', content: 'You complete code.' }, { role: 'user', content: 'x' }],
            context: ['# references: helper.ts'], max_tokens: 4096, temperature: 0,
            top_p: 0.7, family: 'anthropic', capabilities: { thinking: true },
        });

        assert.strictEqual(requestBody?.system, 'You complete code.\n\n# references: helper.ts');
        assert.strictEqual(requestBody?.top_p, undefined);
        assert.strictEqual(requestBody?.temperature, undefined);
        assert.deepStrictEqual(requestBody?.thinking, { type: 'enabled', budget_tokens: 2_048 });
    });

    test('Anthropic short output requests omit an invalid manual thinking budget', async () => {
        let requestBody: Record<string, unknown> | undefined;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({ content: [{ type: 'text', text: '42' }], stop_reason: 'end_turn' }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;
        const response = await new AnthropicAdapter().send({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'claude-sonnet-4-5-20250929',
            messages: [{ role: 'user', content: 'Next line?' }], max_tokens: 40, temperature: 0,
            family: 'anthropic', capabilities: { thinking: true },
        });
        assert.strictEqual(requestBody?.thinking, undefined);
        assert.strictEqual(requestBody?.temperature, 0);
        assert.strictEqual(response.text, '42');
    });

    test('Anthropic adaptive models omit sampling and read text after thinking blocks', async () => {
        let requestBody: Record<string, unknown> | undefined;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({
                content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'src/a.ts:7' }],
                stop_reason: 'end_turn',
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const response = await new AnthropicAdapter().send({
            baseUrl: 'https://example.test', apiKey: 'key', model: 'claude-sonnet-5',
            messages: [{ role: 'user', content: 'Next line?' }], max_tokens: 2048,
            temperature: 0, top_p: 0.7, family: 'anthropic', capabilities: { thinking: true },
        });
        assert.deepStrictEqual(requestBody?.thinking, { type: 'adaptive' });
        assert.strictEqual(requestBody?.temperature, undefined);
        assert.strictEqual(requestBody?.top_p, undefined);
        assert.strictEqual(response.text, 'src/a.ts:7');
    });
});
