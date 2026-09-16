// ELK detects a document-less WorkerGlobalScope and installs its native message
// handler. Keeping this separate prevents it replacing our revisioned handler.
import 'elkjs/lib/elk-worker.min.js';
