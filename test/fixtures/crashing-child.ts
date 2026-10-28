// A PDF reader that dies while reading, as an out-of-memory would end it.
process.once('message', () => {
    process.send?.({ type: 'progress', phase: 'open', pageNumber: 0 });
    process.stderr.write('FATAL ERROR: Reached heap limit\n');
    process.exit(134);
});
