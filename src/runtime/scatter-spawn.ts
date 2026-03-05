/**
 * Scatter — Spawn runtime implementation.
 *
 * `scatter.spawn(fn, options)` creates a long-lived worker with named,
 * direction-typed shared-memory channels for zero-copy cross-thread I/O.
 *
 * Returns a `ThreadHandle` with channel access and lifecycle control.
 */

import type {SpawnOptions, ThreadHandle} from '../scatter.js';
import type {ChannelDef, ChannelDefinitions, ChannelMeta, MainSideChannels, SharedChannel,} from '../memory/shared-channel.js';
import {createChannel} from '../memory/shared-channel.js';
import {materialize} from '../virtual-worker.js';
import type {SpawnContext} from '../context.js';

/**
 * Spawn a long-lived worker with named, direction-typed shared-memory channels.
 */
export function scatterSpawn<T extends ChannelDefinitions>(
    fn: (ctx: SpawnContext<T>) => void | Promise<void>,
    options: SpawnOptions<T>,
): ThreadHandle<T> {
    if (typeof fn !== 'function') {
        throw new TypeError(`scatter.spawn: expected a function, got ${typeof fn}`);
    }
    if (!options?.channels || typeof options.channels !== 'object') {
        throw new TypeError('scatter.spawn: options.channels must be an object of channel definitions');
    }

    // 1. Create channels from definitions
    const channelEntries = Object.entries(options.channels) as [string, ChannelDef][];
    const channels = new Map<string, { full: SharedChannel<unknown>; def: ChannelDef }>();
    const channelMeta: Record<string, ChannelMeta> = {};

    for (const [name, def] of channelEntries) {
        const ch = createChannel({
            capacity: def.capacity,
            codec: def.codec ?? 'structured',
        });
        channels.set(name, {full: ch, def});
        channelMeta[name] = ch.meta;
    }

    // 2. Materialize worker
    const vw = materialize(fn as Function, {
        mode: 'spawn',
        imports: options.imports ? [...options.imports] : [],
        data: options.data ? {...options.data} : {},
        channelMeta,
        signal: options.signal,
    });

    // 3. Build main-side channel map (direction-inverted)
    // Main sees 'in' channels as writable, 'out' channels as readable
    const mainChannels = {} as Record<string, unknown>;
    for (const [name, {full}] of channels) {
        // SharedChannel implements both ReadableChannel and WritableChannel.
        // The type system enforces correct usage via MainSideChannels<T>.
        mainChannels[name] = full;
    }

    // 4. Build handle
    let alive = true;

    const handle: ThreadHandle<T> = {
        channels: mainChannels as MainSideChannels<T>,

        get alive(): boolean {
            return alive && !vw.disposed;
        },

        get threadId(): number {
            return vw.threadId;
        },

        terminate(): void {
            if (!alive) return;
            alive = false;
            for (const {full} of channels.values()) {
                try {
                    full.close();
                } catch {
                }
            }
            vw.dispose();
        },

        async shutdown(): Promise<void> {
            if (!alive) return;

            // Close inbound channels to signal end-of-input to the worker
            for (const [, {full, def}] of channels) {
                if (def.direction === 'in') {
                    try {
                        full.close();
                    } catch {
                    }
                }
            }

            // Wait for worker function to complete
            await vw.shutdown();

            // Close remaining channels
            for (const {full} of channels.values()) {
                if (!full.closed) {
                    try {
                        full.close();
                    } catch {
                    }
                }
            }
            alive = false;
        },

        [Symbol.dispose](): void {
            handle.terminate();
        },

        async [Symbol.asyncDispose](): Promise<void> {
            await handle.shutdown();
        },
    };

    return handle;
}
