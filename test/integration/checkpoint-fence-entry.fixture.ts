// Emit before loading the graph/ORM tree so timeout diagnostics distinguish slow imports
// from an initialized worker that reached PostgreSQL. No config or input is sent here.
process.send?.({event:'loading'});
const {runFenceWorker}=await import('./checkpoint-fence-worker.fixture.js');
await runFenceWorker();
