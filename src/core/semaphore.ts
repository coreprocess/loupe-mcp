/** Counts slots of a limited resource; `acquire` waits in arrival order until one is free. */
export class Semaphore {
    #free: number;
    readonly #waiting: (() => void)[] = [];

    constructor(slots: number) {
        this.#free = slots;
    }

    async acquire(): Promise<() => void> {
        if (this.#free > 0) this.#free--;
        else await new Promise<void>((resolve) => this.#waiting.push(resolve));
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = this.#waiting.shift();
            if (next) next();
            else this.#free++;
        };
    }

    /** Runs the task in a slot. */
    async run<T>(task: () => Promise<T>): Promise<T> {
        const release = await this.acquire();
        try {
            return await task();
        } finally {
            release();
        }
    }
}
