// A PDF reader that opens and then never reports another page: the host must kill it.
process.once('message', () => {
    process.send?.({ type: 'progress', phase: 'open', pageNumber: 0 });
    setInterval(() => undefined, 1000);
});
