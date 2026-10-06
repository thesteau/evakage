// Saves a file to disk as it is produced, without holding it in memory.
//
// The page registers a one-time save with its service worker, then points a
// hidden iframe at /save-stream/<id>. The worker answers that navigation with
// an attachment response whose body it pulls from the page one chunk at a
// time, so the browser writes each chunk to disk before the next is produced.
// If the page reports an error, the worker errors the body and the browser
// marks the download failed rather than completing it.
//
// Chunks travel page -> worker as ordinary worker messages, which also keep
// the worker alive; requests for the next chunk come back over a MessagePort.

const REGISTER_MS = 5000;
// How long the browser has to start the download after the iframe is added.
// Past this the save is withdrawn and the caller falls back to an in-memory save.
const FIRST_PULL_MS = 15000;

export class StreamSaveUnavailable extends Error {}

/** Whether this page can stream a save through its service worker. */
export function streamSaveAvailable() {
  return Boolean(navigator.serviceWorker?.controller);
}

export async function saveStream({
  name,
  size,
  source,
  signal,
}: {
  name: string;
  size: number;
  source: AsyncIterator<Uint8Array>;
  signal?: AbortSignal;
}) {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) throw new StreamSaveUnavailable('No service worker controls this page.');
  const id = crypto.randomUUID();
  const channel = new MessageChannel();

  let frame: HTMLIFrameElement | null = null;
  let started = false;
  let settled = false;
  let failed = false;

  const send = (message: object, transfer: Transferable[] = []) =>
    worker.postMessage({ ...message, id }, transfer);

  try {
    return await new Promise((resolve, reject) => {
      const finish = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        channel.port1.close();
        if (error) {
          failed = true;
          // A save that never started is withdrawn so a late navigation gets nothing.
          send({
            type: started ? 'save-error' : 'save-abandon',
            message: String((error as Error)?.message || error),
          });
          reject(error);
        } else resolve(undefined);
      };
      const onAbort = () => finish(signal?.reason || new Error('Save aborted.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();

      let timer = setTimeout(
        () => finish(new StreamSaveUnavailable('The service worker did not accept the save.')),
        REGISTER_MS,
      );

      let pulling = false;
      channel.port1.onmessage = async (event) => {
        const type = event.data?.type;
        if (type === 'registered') {
          clearTimeout(timer);
          timer = setTimeout(
            () => finish(new StreamSaveUnavailable('The browser did not start the download.')),
            FIRST_PULL_MS,
          );
          frame = document.createElement('iframe');
          frame.hidden = true;
          frame.src = `/save-stream/${id}`;
          document.body.append(frame);
        } else if (type === 'refused') {
          finish(new StreamSaveUnavailable('The service worker refused the save.'));
        } else if (type === 'cancel') {
          finish(new Error('The download was cancelled.'));
        } else if (type === 'pull' && !pulling && !settled) {
          if (!started) {
            started = true;
            clearTimeout(timer);
          }
          pulling = true;
          try {
            const { value, done } = await source.next();
            if (settled) return;
            if (done) {
              send({ type: 'save-done' });
              finish(null);
            } else {
              // Copy into an exact-size buffer so it can be transferred, not cloned.
              const chunk =
                value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
                  ? value
                  : value.slice();
              send({ type: 'save-chunk', chunk }, [chunk.buffer]);
            }
          } catch (err) {
            finish(err);
          } finally {
            pulling = false;
          }
        }
      };
      channel.port1.start();
      worker.postMessage({ type: 'save-stream', id, name, size }, [channel.port2]);
    });
  } finally {
    // After a success, removing the frame right away can cancel a download some
    // engines are still committing, so it stays briefly. After a failure there
    // is nothing to keep, and Firefox otherwise leaves the frame on a download
    // that never settles.
    const done = frame as HTMLIFrameElement | null;
    if (done) setTimeout(() => done.remove(), failed ? 0 : 10000);
  }
}
